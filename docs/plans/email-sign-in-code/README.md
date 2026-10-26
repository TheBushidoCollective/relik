# Spec: email sign-in with a code you type, alongside the link

**Answers recorded 2026-10-26 (Jason, asked in one batch):** Q1 Yes, a session started by a typed code may add the address's first passkey within `passkeyFreshLinkSeconds`, like a link. Q2 Yes, a code works only in the browser that asked for it. Every "If Q1 is Yes" clause below applies; every "If No" clause is dropped.

Everything below was read in `/Users/jwaldrip/dev/worktrees/relik-email-signin-code` at `ad6b6f57`. Paths are relative to that root. Anything I didn't confirm directly is marked [INFERENCE].

## 0. Goal

A reader asks to sign in from a relic's comment composer. One email arrives with a six-digit code and the usual link. The reader types the code into the page that asked and is signed in on that page, with no navigation. The key stays in the tab's memory, the comment they post carries their address, and the link in that email stops working. The link still works on its own, as it does today.

## 1. Corrections to the brief

1. **A code check keyed by a secret in the bucket gives no protection.** The existing server secrets are stored in the same bucket: `m/secret/unsubscribe-key.json` (`gcsstore.ts:943-971`) and `m/secret/passkey-decoy-key.json` (`gcsstore.ts:1146-1174`). Anyone who can read the code rows can read the key and brute-force six digits offline. **Settled:** the code is bound to the browser that asked for it. A random 32-byte value goes into an HttpOnly cookie on the request's 202. The code row is filed under a hash of that value and stores an HMAC keyed by it. A bucket reader holds neither, and no new secret has to be provisioned. This needs Jason's confirmation, see §9 Q2.
2. **Looking codes up by address creates an activity oracle.** `{email, code}` against a store keyed by address tells a prober whether that address has a pending sign-in. With the browser binding, `POST /api/auth/code` carries only `{code}`. A caller can only reach a row through a value its own browser was given, so there is no address in the request to probe.
3. **`consumeAuthLink` on GCS is not single-use across instances.** `gcsstore.ts:788-796` does a `get`, then an unconditional `remove(name)`, so two concurrent consumers can both mint a session. `consumeWebauthnChallenge` (`gcsstore.ts:1122-1131`) already does it correctly with `remove(name, generation)`. Once a code can spend the same link, this race matters and has to be fixed.
4. **An in-memory per-address limiter can't bound guessing.** `addressLimiter` (`app.ts:166-171`) is per instance. The attempt budget has to live in the store, charged with a compare-and-swap before the code is compared. Otherwise concurrent guesses all read "under the limit" (a time-of-check/time-of-use gap).
5. **Unfollowed links are never swept.** The lifecycle rule covers only `m/challenge/` and `m/dedup/` (`deploy/terraform/modules/relic/locals.tf:36-39`, `resource.google_storage_bucket.relics.tf:22-30`), so `m/authlink/` objects never expire. This gap already exists and is not fixed here. The new rows go under `m/challenge/` so the existing one-day rule removes them with no Terraform change.
6. **Reusing the other-tab path would drop the passkey offer.** The offer mounts only at boot (`main.ts:7233-7260`). `recheck` never mounts it (`main.ts:7193-7199`), and `takePasskeyOfferMarker` caches its first answer per document, including `false` (`comments.ts:1478-1482`). A same-tab code sign-in would never show the offer. `viewer.md:584` claims it mounts on "boots or re-checks", which the code doesn't do.
7. **The lazy chunks can't import the new module.** `passkey-sign-in.ts` and `decision-panel.ts` are lazy chunks, and `shell-budget.test.ts:77-112` requires the passkey ceremony code to stay out of `viewer.js`. So the code-entry module lives in the main bundle and reaches lazy surfaces by injection (§4.10). It must never import `passkey-common.ts`, and lazy modules must not import main-bundle values. [INFERENCE] Doing either changes the chunk graph.
8. **The dashboard puts its outcome inside its `<form>`** (`main.ts:9431`). The code field can't be a nested form. Pressing Enter in it would submit the outer form and re-send the email unless that's handled. A `required` or `pattern` attribute on the field would block the dashboard's own submit.
9. **The decision panel never repaints for a fresh session at the same address.** Its `recheck` compares addresses only (`decision-panel.ts:1729-1740`). After a code, it has to call `enterPasskey(verdict)` directly.
10. **The homepage needs nothing.** The only callers of `/api/auth/request` are `comments.ts:592`, `main.ts:9303` and `main.ts:9462`. The homepage has no sign-in, and its CSP omitting `connect-src` doesn't matter.
11. **No `relic-mcp` source changes and no client release.** `relic-mcp/src` has no auth calls (grep). Only `relic-mcp/test/*` and `PATH.md` files change.
12. **PATH proofs don't run under `mise run verify`.** `bun test` only matches `*.test.ts`. CI runs the proofs explicitly (`.github/workflows/verify.yml:92-109`), so the new proof needs a CI step.
13. **Adding a parameter to `Mailer.send` is source-compatible.** Every existing fake `send(to, url)` stays assignable when a third `code` parameter is added.

## 2. Thin path and acceptance (the new PATH.md section, inserted first)

```markdown
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
```

Measurements behind the step lines:
- **`navigations=0`**: a `window.__relicCodeProofMarker` set before typing is still present afterwards, `performance.timeOrigin` is unchanged, and zero main-frame `Page.frameNavigated` events fired.
- **`subject_has_code`**: the code is extracted from the rendered `signInMail(link, code).subject` with `/^(\d{6}) is your Relic sign-in code$/`. That extracted code is the one typed.
- **`shape_equal`**: all the 401 bodies are identical once `instance` is deleted.

## 3. Decisions settled here (Jason may override; none are parked)

- **Six random decimal digits**, drawn with rejection sampling so there is no modulo bias.
- **Attempt budget:** 10 code attempts per address per day, held in the store and charged before the code is compared, right or wrong. That bounds a guesser to at most 10/10⁶ per targeted address per day (≤0.37% per year), and every day of guessing costs them at least one email to the target. There is no separate per-code cap, because the address budget is the bound.
- **One email, one sign-in.** Verifying the code spends the link, and following the link spends the code. The link row is the single deciding object and is removed with a conditional delete.
- **The latest request wins in a browser**, because each 202 overwrites the cookie. Older code rows elsewhere can't be reached without their cookie and expire with their link.
- **Every failure gives one answer:** `401 sign_in_code_failed`, with no extensions. That covers a missing or malformed cookie, an unknown request, an expired code, a wrong code, an exhausted budget, a spent link, and a superseded code. Shape errors give `400 invalid_sign_in_code`; per-IP throttling gives `429 auth_rate_limited`.
- **The email subject carries the code.** The browser binding makes a code seen on a lock screen useless elsewhere, and a per-message subject stops Gmail from threading sign-in emails, so the newest code is the visible one.
- **The button changes** from "Send me a link" to "Email me a code". Full copy is in §4.11.
- **The code field auto-submits** at six digits (typing, paste, or autofill). After a rejection it never auto-resubmits the same value.

## 4. Shared contracts (verbatim)

### 4.1 HTTP

**`POST /api/auth/request`** keeps its current behaviour (`app.ts:3123-3175`) and adds the following:
- It always generates `nonce = newAuthToken()`.
- For a well-formed address, after `putAuthLink` it calls `putSignInCode` (§4.4) with the same `expiresAt` and `linkTokenHash`.
- It calls `mailer.send(email, link, code)` inside the existing try/catch.
- It always answers `202` with `Set-Cookie: <request cookie>` (§4.2). That holds for valid addresses, garbage, a missing email, no mailer, and a provider refusal. A 429 sets no cookie.

**`POST /api/auth/code`** (new). The route goes beside `auth/request` in `app.ts:512-520`. Steps, in order:
1. Run `limiter.check(rateLimitKey('auth-code', ip), config.signInCodeRateLimit, now)`. If refused, answer `429 auth_rate_limited {retry_after_seconds}`.
2. If `content-type` doesn't start with `application/json` (case-insensitive), answer `400 invalid_sign_in_code`.
3. Read the body with `readBoundedJson(request, 'invalid_sign_in_code')` (`app.ts:3410`). It must be a non-array object whose `code` is a string. Strip ASCII spaces and `-`. The result must match `/^[0-9]{6}$/`, or the answer is `400 invalid_sign_in_code`.
4. Read the `relic_sign_in_request` cookie. If it's absent or doesn't match `/^[A-Za-z0-9_-]{43}$/`, answer `401`.
5. `row = getSignInCode(signInRequestHash(nonce))`. If `row` is undefined or `row.expiresAt <= now`, answer `401`.
6. `reserveSignInCodeAttempt(row.addressHash, now, limit, windowSeconds*1000)`. If it returns false, answer `401`. If it throws, let the error become a 500. Never answer about the code without a charged attempt.
7. If `!timingSafeEqual(await signInCodeMac(nonce, code), row.codeMac)` (`app.ts:5013`), answer `401`.
8. `link = consumeAuthLink(row.linkTokenHash)`, then `deleteSignInCode(row.requestHash)`. If `link` is undefined or `link.expiresAt <= now`, answer `401`.
9. Answer `200`, `content-type: application/json`, body `{"email": link.email}`. Set three cookies (with `Headers.append`):
   - `mintReaderSession(link.email, now, 'code')`
   - the offer marker, using the exact string the callback sets (extract it into a `passkeyOfferCookie()` helper and use it in both places)
   - the cleared request cookie

Every 401 above is `refuse('sign_in_code_failed')` with no options. `GET /api/auth/callback` is unchanged in `app.ts`.

### 4.2 Cookie

- **Set on every 202:** `relic_sign_in_request=<nonce>; Path=/api/auth/code; HttpOnly; Secure; SameSite=Strict; Max-Age=${config.authLinkTtlSeconds}`.
- **Cleared on a code 200:** `relic_sign_in_request=; Path=/api/auth/code; HttpOnly; Secure; SameSite=Strict; Max-Age=0`.

### 4.3 Derivations (in `app.ts`)

```ts
/** sha256Hex(`relic-sign-in-request:v1:${nonce}`) */
async function signInRequestHash(nonce: string): Promise<string>;
/** hex(HMAC-SHA256(key = the nonce's 32 base64url-decoded bytes, `relic-sign-in-code:v1:${code}`)), via hmacSha256 (app.ts:5021) */
async function signInCodeMac(nonce: string, code: string): Promise<string>;
/** Six decimal digits, uniform: draws ≥ 4_294_000_000 are redrawn, then value % 1_000_000, zero-padded. */
function newSignInCode(): string;
```

No log line may contain a code, a nonce, or a cookie value.

### 4.4 Store (`store.ts`; implemented in `MemoryStore` and `gcsStore`)

```ts
/**
 * A typed sign-in code, mailed beside a magic link and bound to the browser
 * that asked for it. Filed under a hash of the request nonce, which lives only
 * in that browser's HttpOnly cookie; the code is kept as an HMAC keyed by the
 * same nonce, so a reader of the bucket can test no guess offline.
 */
export interface SignInCodeRow {
  /** sha256Hex(`relic-sign-in-request:v1:${nonce}`); also the row's name. */
  readonly requestHash: string;
  /** Hex HMAC-SHA256 keyed by the nonce's 32 bytes over `relic-sign-in-code:v1:${code}`. */
  readonly codeMac: string;
  /** The link mailed with this code. Verifying the code spends that link. */
  readonly linkTokenHash: string;
  /** sha256Hex(normalizeEmail(address)): the attempt budget this code draws on. */
  readonly addressHash: string;
  /** The link's own expiry: the two die together. */
  readonly expiresAt: number;
}

/** Code attempts charged to one address in its current window. */
export interface SignInCodeBudgetRow {
  readonly addressHash: string;
  readonly windowStart: number;
  readonly attempts: number;
}

// RelicStore additions:
putSignInCode(row: SignInCodeRow): Promise<void>;
getSignInCode(requestHash: string): Promise<SignInCodeRow | undefined>;
deleteSignInCode(requestHash: string): Promise<void>;
/**
 * Charge one code attempt to the address before the code is compared.
 * True when the address had fewer than `limit` attempts in the window
 * containing `now` (a window opens at the first attempt after the previous
 * one ended, and lasts `windowMs`). Charges whether or not it allows, so a
 * refused attempt costs the same store work. Compare-and-swap safe across
 * instances; throws rather than allow when it cannot win a write.
 */
reserveSignInCodeAttempt(addressHash: string, now: number, limit: number, windowMs: number): Promise<boolean>;
```

Changes to existing store code:
- `SessionRow.via` becomes `'link' | 'passkey' | 'code'` (`store.ts:329`).
- The doc on `consumeAuthLink` (`store.ts:471-472`) gains: "Exactly one of any number of concurrent consumers, on any instance, gets the row."

GCS:
- Object names are `key('challenge','sign-in-code',`${requestHash}.json`)` and `key('challenge','sign-in-code-budget',`${addressHash}.json`)`.
- `reserve` runs a `casAttempts` loop: `get`; then `put(name, next, current?.generation ?? '0')`; then `return before < limit`. When every attempt loses, it throws `gcs sign-in code budget lost ${casAttempts} compare-and-swap races; refusing to allow an attempt that was never charged`.
- `consumeAuthLink` becomes: `get`; then `if (!(await remove(name, current.generation))) return undefined`; then return the value.

Memory: two maps. `reserve` must not `await` between its read and its write.

### 4.5 Config (`config.ts`, defaults in `DEFAULT_CONFIG`)

```ts
/** Sign-in code submissions per IP. In memory, per instance: the address budget below is the bound that holds across instances. */
readonly signInCodeRateLimit: RateLimitConfig;            // { limit: 30, windowSeconds: 3600 }
/** Code attempts per address per window, counted in the store with compare-and-swap; at most a day, because the row lives under the one-day transient prefix. */
readonly signInCodeAddressAttemptLimit: RateLimitConfig;  // { limit: 10, windowSeconds: 86_400 }
```

`assertConfig` requires both to have integer `limit ≥ 1` and `windowSeconds ≥ 1`. It also throws `'signInCodeAddressAttemptLimit.windowSeconds must be at most 86400: the budget row lives under the one-day transient lifecycle prefix, which would cut a longer window short'`.

Doc-only edits: `authLinkTtlSeconds` reads "How long a sign-in email's link and code stay usable." If Q1 is Yes, `passkeyFreshLinkSeconds` reads "…after a sign-in email (its link or its code) starts a session…".

### 4.6 Problem codes (`problems.ts`)

Add the following, with the comment "Typed sign-in code. Every failure is one answer, so the endpoint cannot tell anybody whether a code exists, expired, was spent, or was guessed too often.":
- `invalid_sign_in_code`: 400, `'Invalid sign-in code payload'`
- `sign_in_code_failed`: 401, `'Sign-in code did not work'`

If Q1 is Yes, the title of `passkey_fresh_link_required` becomes `'Adding a first passkey needs a fresh sign-in from an email'`.

### 4.7 Sessions

`mintReaderSession(email, now, via: 'link' | 'passkey' | 'code')`.

If Q1 is Yes, `mayAddFirstPasskey` becomes `const via = session.via ?? 'link'; return (via === 'link' || via === 'code') && now - session.createdAt <= config.passkeyFreshLinkSeconds * 1000;`.

### 4.8 Mail

`Mailer.send(email: string, link: string, code: string): Promise<void>` (`app.ts:104`). `resendMailer.send` posts `signInMail(link, code)`.

```ts
export function signInMail(link: string, code: string): OutboundMail
subject: `${code} is your Relic sign-in code`
text (joined by '\n'):
  'Your Relic sign-in code:', '', code, '',
  'Type it on the page where you asked to sign in. It works only in the browser that asked for it.', '',
  'Or open this link to sign in instead:', '', link, '',
  'The code and the link are single use and expire shortly, and using either one spends both. Relic never asks you for this code, so do not give it to anyone. If you did not ask to sign in, nothing has happened and you can ignore this message.'
html: the same paragraphs in <p>. The code sits in
  <p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;font-weight:600;letter-spacing:6px;margin:16px 0">
and the link stays an escaped <a>. Both are run through escapeHtml.
```

Update the doc comment to "The code and the link are the whole message."

If Q1 is Yes, the first-passkey paragraph of `passkeyAddedMail` (`mail.ts:432`) reads "…or used a browser that had just signed in with a link or code sent here. Relic has no way to remove a passkey."

### 4.9 Viewer module `packages/relic-viewer/src/sign-in-code.ts` (new, main bundle only)

Imports are limited to `./comments.ts` (`plainLabel`) and types from `./viewer.ts`. **It never imports `passkey-common.ts`.**

```ts
export const SIGN_IN_CODE_LENGTH = 6;
export type SignInCodeResult =
  | { readonly kind: 'verified'; readonly email: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number }
  | { readonly kind: 'failed' };
/** ASCII digits only, first six. "123 456" and "123-456" become "123456". */
export function normalizeSignInCode(raw: string): string;
/** POST `${serviceOrigin}/api/auth/code`, JSON {"code"}. Sends no address, no relic id, never the fragment.
 *  200 with a non-empty email → verified; 401 → rejected; 429 → rate_limited (body retry_after_seconds, else Retry-After); else or throw → failed. */
export async function submitSignInCode(code: string, deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>): Promise<SignInCodeResult>;
export interface SignInCodeEntryOptions {
  readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  /** Runs once, after the session cookie is set. */
  readonly onVerified: (email: string) => void;
  /** Focus the field in a microtask after creation (callers append synchronously). */
  readonly focus?: boolean;
}
export function signInCodeEntry(options: SignInCodeEntryOptions): HTMLElement;
/** Moved verbatim from main.ts:3288-3294. */
export function announceVerified(): void;
export const SIGN_IN_CODE_LABEL = 'Code from the email';
export const SIGN_IN_CODE_SUBMIT = 'Sign in';
export const SIGN_IN_CODE_CHECKING = 'Checking the code.';
export const SIGN_IN_CODE_REJECTED = 'That code did not work. Check it against the newest email from Relic, and type it in the browser that asked for it.';
export const SIGN_IN_CODE_REJECTED_AGAIN = 'That code still did not work. A code works once, only in the browser that asked for it, and stops working after a newer email or too many wrong tries. Open the link in the email instead, or send a new one.';
export const SIGN_IN_CODE_FAILED = 'The code could not be checked, which is a network problem rather than a wrong code. Try again.';
export function signInCodeRateLimitedCopy(retryAfterSeconds?: number): string;
// undefined → 'Too many codes tried from here. Wait a few minutes, or open the link in the email.'
// m = ceil(s/60) → `Too many codes tried from here. Wait about ${m} minute${m === 1 ? '' : 's'}, or open the link in the email.`
export function signedInCopy(email: string): string;   // `Signed in as ${plainLabel(email)}.`
```

DOM (the contract for CSS, tests and the PATH proof). `{n}` is a module counter:

```html
<div class="sign-in-code" data-sign-in-code="" data-state="idle">
  <label class="compose-field sign-in-code-field"><span>Code from the email</span>
    <input class="compose-input sign-in-code-input" data-sign-in-code-input="" type="text"
      inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false"
      enterkeyhint="go" aria-describedby="sign-in-code-status-{n}"></label>
  <button type="button" class="action primary sign-in-code-submit" data-sign-in-code-submit="" disabled>Sign in</button>
  <p class="sign-in-code-status" data-sign-in-code-status="" id="sign-in-code-status-{n}" role="status" aria-live="polite"></p>
</div>
```

The input gets no `required`, `pattern` or `maxlength` (see §1.8).

`data-state` takes one of: `idle`, `checking`, `rejected`, `rate-limited`, `failed`, `verified`.

Behaviour:
- **On `input`:** normalize the value. Enable the button only at 6 digits and only when not checking. Submit when the value has 6 digits and differs from the last submitted value.
- **On `keydown` Enter:** always `preventDefault()`, then submit if there are 6 digits.
- **While checking:** disable the input and button, and show the checking copy.
- **Rejected:** show `REJECTED` for the first and second rejection and `REJECTED_AGAIN` from the third. Re-enable the controls and `select()` the input.
- **Failed:** clear the last-submitted value so the same value can be resubmitted.
- **Verified:** show `signedInCopy`, disable the controls, and call `onVerified` once.

### 4.10 Step 0 type (`passkey-common.ts:400-406`; applied by the main agent, only if Q1 is Yes)

The `'sent'` variant gains:

```ts
/** Builds the field for the code in that email. The surface appends it under the message and continues from
 *  `onVerified`, which runs after the session cookie is set, the offer marker is consumed, and other tabs are told. */
readonly codeEntry?: (onVerified: (email: string) => void) => HTMLElement;
```

### 4.11 Copy changes (old → new, by owner)

**V1, `comments.ts`:**
- `DELIVERY_DISCLOSURE`: "Sending the sign-in email means handling your address in the clear. There is no other way to post it."
- `KEY_AT_RISK_NOTE`: "This browser is not keeping the key for this relic, so following the link in this tab would lose it. Type the code from the email here instead, or open the link in a new tab and come back to this one, which still holds the key in memory."
- `auth_rate_limited`:
  - headline: "Too many sign-in emails asked for from here just now"
  - detail: "Check the email already sent before asking for another: its code or link may still be good."
- `invalid_session` detail: "Verification is a short-lived session rather than an account, so it lapses, and each sign-in email works once. Enter your address again and use the new one."

**V1, `main.ts`:**
- Both buttons: "Email me a code".
- `linkSentCopy`: `If ${addr} can receive mail, an email with a code and a link is on its way. Type the code below to sign in on this page, or follow the link: it verifies the address and brings you back here.`
- `dashboardLinkSent`: `If ${addr} can receive mail, an email with a code and a link is on its way. Type the code below, or follow the link: it verifies the address and brings you back to this dashboard.`

**V2 (only if Q1 is Yes):**
- `COPY_LINK_REQUIRED_LEAD`: "A first passkey can only be added right after you sign in from an email."
- `COPY_LINK_SEND`: "Email me a new code"
- `COPY_LINK_FAILED`: "Relic could not send the email just now. Try again later."
- `linkRequiredBody`:
  - with an address: `${LEAD} Email a new code to ${email}, type it here, then add your passkey.`
  - without one: `${LEAD} Email yourself a new code, type it here, then add your passkey.`
- `COPY_OFFER_ERROR`: "Relic could not set up a passkey just now. You can add one the next time you sign in from an email."
- `DECISION_LINK_REQUIRED`: `${LEAD} Email a new code, type it here, and setting up the passkey carries on. Nothing was recorded.`

Unchanged, because they stay true: `COPY_OFFER_BODY`, `COPY_RATE_LIMITED`, `invalid_session`'s title, the quota log line, and the policy's "instead of a link".

### 4.12 `/policy` (`disclosureStatement`, `app.ts:5717-5720`, owned by S)

Replace the first three sentences with:

> We do keep who commented on which relic and when: a commenter is the email address they verified with a sign-in email, by following its link or typing its code, stored in the clear beside each comment. A sign-in email, and every email below, passes the address through our mail provider. A sign-in code works once, only in the browser that asked for it: until it is used or expires, the service keeps it as a hash keyed by a random value that only that browser holds, and for a day it counts code attempts for each address, filed under a hash of the address.

Keep the passkey sentence verbatim.

If Q1 is Yes, `app.ts:5757` changes "only a session that a sign-in link started in the previous N minutes can begin adding it" to "only a session that a sign-in email started in the previous N minutes, by its link or its code, can begin adding it".

## 5. Step 0 (main agent, before any dispatch)

1. Ask the two questions in §9 in a single batch.
2. If Q1 is Yes, apply §4.10.
3. Commit this spec, with the answers recorded, as `docs/plans/email-sign-in-code/README.md`.
4. Push `feat/email-signin-code`.

Every worker then branches from that commit into `~/dev/worktrees/relik-code-<slice>`. Workers commit there, and the main agent integrates everything into the one PR.

## 6. Slices

Slices S, V1, V2, G, D and P all start right after Step 0. P's acceptance is checked only after S, V1 and V2 have been merged into the integration branch. **No file is owned by two slices.**

**S (server).**
- **Files:** `relic-server/src/{problems,config,store,gcsstore,app,mail}.ts`; `test/sign-in-code.test.ts` (new); `test/gcsstore.test.ts`; `test/mail.test.ts`; `test/passkey-sign-in.test.ts`. Also comment-only edits to `deploy/terraform/modules/relic/locals.tf:33-35` and `resource.google_storage_bucket.relics.tf:19-21`, naming the sign-in code rows.
- **Change:** everything in §4.1 through §4.8 and §4.12.
- **Existing assertions to update:**
  - `mail.test.ts:108,609` (subject)
  - if Q1 is Yes: `mail.test.ts:496,502`, server `passkey-sign-in.test.ts:1499`, `1674`, `1912`
- **Non-goals:** no change to the link TTL, the callback redirect, `/api/auth/request`'s 202 rule or its content-type tolerance, or the lifecycle of `m/authlink/`. No log line carries a code or nonce.
- **Acceptance (assertions in `sign-in-code.test.ts`):**
  - Every 202 sets the exact cookie string; a 429 sets none.
  - The mailer receives a 6-digit code.
  - The right code with the cookie answers 200 `{email}` with the three cookies, and `GET /api/auth/session` then returns the address.
  - The session row records `via: 'code'`.
  - The link then answers 401 `invalid_session`.
  - Following the link first makes the code answer 401.
  - Replaying the code answers 401.
  - These all give byte-identical 401 bodies apart from `instance`: wrong code, no cookie, unknown nonce, expired (clock advanced past 900 s), and superseded (a second request's cookie with the first code).
  - Ten wrong codes followed by the right one answers 401, while the link still answers 303. Case variants of an address share one budget. After 24 hours, a new request and its right code answer 200.
  - Shape errors (non-JSON, malformed body, missing or non-string `code`, 5 or 7 digits, letters) answer 400. `"123 456"` is accepted.
  - The 429 from `auth-code` is independent of the request limiter.
  - If Q1 is Yes: a code session within 15 minutes gets a `create` challenge, and after 16 minutes it gets 401 `passkey_fresh_link_required`.
  - Two `createApp` instances over one `fakeGcs` give exactly one success when the code and the link race.
  - Twelve concurrent reservations across two `storeOn(gcs, 32)` instances with limit 10 give exactly 10 `true`, and the row reads `attempts: 12`.
  - With `contendOn(budget, -1)`, the right code answers 500 and never 200.
  - Two instances racing `consumeAuthLink` give exactly one row.
  - A both-stores conformance test covers the new methods.

**V1 (viewer main bundle).**
- **Files:** `relic-viewer/src/{sign-in-code.ts (new), comments.ts, main.ts}`; `test/{sign-in-code.test.ts (new), comments.test.ts, share.test.ts (lines 508 and 652), dashboard-and-key-entry.test.ts}`, plus any other test that asserts the DOM of the sign-in sent state.
- **Change:**
  - Add §4.9.
  - Add `takeFreshPasskeyOfferMarker(doc = globalThis.document): boolean` in `comments.ts`. It re-reads the cookie, ignoring a cached `false`. If the marker is present it clears it, caches `true`, and returns `true`.
  - `signInForm` (`main.ts:3296-3378`): in the sent state, append `signInCodeEntry({deps, focus: true, onVerified})` after the message and warning. `onVerified` does, in order: `offerPending = takeFreshPasskeyOfferMarker()`; `outcome.replaceChildren(line('thread-note', signedInCopy(email)))`; `announceVerified()`; `options.onSignedIn?.({ offerPending })`. The type of `onSignedIn` becomes `(signal?: { readonly offerPending: boolean }) => void`.
  - Composer: extract `mountOfferFor(email): boolean` from `main.ts:7233-7260`. `initialise` calls it when `takePasskeyOfferMarker()` is true. The composer's `onSignedIn` sets `offerOwed = signal?.offerPending === true` and calls `recheck()`. `recheck` mounts an owed offer once the session is verified and repaints if the session changed or an offer mounted.
  - Share and decision-panel `signIn`: unchanged, so the marker is consumed and dropped.
  - Dashboard sign-out form: show the sent text plus a code entry. On verify: `announceVerified(); location.reload()`. Don't consume the marker, so the reload shows the offer.
  - If Q1 is Yes: `requestFreshLink` and the dashboard offer's `requestLink` return `codeEntry: codeEntryFactory(deps)`. The factory wraps `onVerified` with `takeFreshPasskeyOfferMarker(); announceVerified();`.
  - Apply the V1 copy in §4.11.
  - The `main.ts` copy of `announceVerified` is deleted in favour of the import.
- **Non-goals:** `styles.css`, `passkey-*`, `decision-panel.ts`, `share.ts`, the homepage.
- **Acceptance:**
  - The new tests prove `normalizeSignInCode`, the status mapping in `submitSignInCode`, a request body that is exactly `{"code":"123456"}`, every DOM state, auto-submit, Enter not submitting the outer form (no second `/api/auth/request`), and the copy escalating at the third rejection.
  - The fragment test (`comments.test.ts:817-824`) also covers `/api/auth/code`.
  - The composer mounts the offer after a code when the marker is present, and doesn't when it's absent.

**V2 (viewer lazy chunks).**
- **Files:** `passkey-common.ts` (copy only), `passkey-sign-in.ts`, `decision-panel.ts`; `test/passkey-sign-in.test.ts`, `test/decisions.test.ts` (lines 1159, 1162, 1167, 1206 and 1266, 1273, 1318 if Q1 is Yes).
- **Change:**
  - Offer card: add a `<div data-passkey-offer-code>` after the warning element. In `link-sent`, when `outcome.codeEntry` exists, render it there. Its `onVerified` empties that div, calls `setState('loading')` and runs `fetchOptions()`. Empty the div whenever the card enters any other state.
  - Decision panel: build the element once when the step becomes `sent`, keep it in the step, and re-append the same node on every repaint. Its `onVerified` calls `enterPasskey(verdict)` if the panel is open.
  - Apply the V2 copy.
  - Import nothing from the main bundle.
- **Non-goals:** the fetch logic, ceremonies, chunking.
- **Acceptance:**
  - With an injected factory, the card goes `link-sent` → `loading` → `ready` with the create button enabled (mocked options).
  - The panel goes `sent` → options → `create`.
  - An outcome without `codeEntry` behaves exactly as it does today.
  - `shell-budget.test.ts` stays green.

**G (designer agent).**
- **Files:** `docs/plans/email-sign-in-code/mockup.html` (new); in `packages/relic-viewer/src/styles.css`, a new `.sign-in-code` block only.
- **Change:** a self-contained, offline, clickable mock using the viewer's own tokens (`styles.css:14-56`) and the real copy. It covers:
  - the composer before and after send, including a key-at-risk variant
  - every entry state, and the verified flip to "Commenting as" with the offer card
  - the dashboard form
  - the offer card going link-required → link-sent with the code → ready
  - the decision panel's sent step
  - the email (subject, text and HTML)
  - widths of 390 and 1280, light and dark
  
  The CSS block is the mock's rules verbatim. Monospace tabular input, the checking/rejected/verified treatments matching the existing link-sending and oxide rules, full width inside `.passkey-offer` and `.decision-passkey`, no overflow at 320 px.
- **Non-goals:** any other selector, emoji, external assets, lorem ipsum.
- **Acceptance:** opens offline; every state is reachable by clicking; the selectors and declarations match the `styles.css` block exactly.

**D (docs).**
- **Files:** `docs/spec/service.md`, `docs/spec/viewer.md`, `docs/frame.md`, `docs/decisions.md`, `README.md`.
- **Change:**
  - `service.md:37` (the 401 exception list), `132`, `155` (the cookie), `80` and `221` (the IP-keyed limits).
  - A §1.9 table with rows for `invalid_sign_in_code` 400 and `sign_in_code_failed` 401, and a paragraph stating §4.1's rules.
  - `service.md:405`, `412`; `459-464` gains item 3, code sign-in; `469`. If Q1 is Yes, `272` and `284`.
  - `viewer.md:478` (item 9), `481`, `485-490`. A new §6.11 "The sign-in code" with the DOM, states, copy, focus, binding and per-surface behaviour. The 6.10 title and lines `574`, `584` (correct "re-checks"), `585`.
  - `frame.md:134`, `135`, `140`, plus a new price bullet: "A typed code is guessable, inside a bound", with the arithmetic in §3 and the lockout residual. If Q1 is Yes, `143`.
  - `README.md:174`.
  - A new `decisions.md` entry, "2026-10-26: A sign-in email carries a code the reader can type". It records Jason's answers and covers the problem, one email one sign-in, the browser binding, charge-before-compare, the single failure answer, and the link's conditional delete. Its residuals:
    - the guess bound
    - anyone who knows an address can spend that address's daily attempts for the code (the link still works)
    - a cross-site POST to `/api/auth/request` can overwrite a browser's request cookie
    - an attacker-initiated code can be phished from the victim
    - `m/authlink/` is never swept
- **Non-goals:** `publish.md:143` and the `relic-mcp` README and SKILL stay as they are, because they're still true and changing them would need a client release. No new external citations (otherwise `frame.sources.txt` has to change).
- **Acceptance:** every location above states the facts in §4. Running `grep -n "magic link\|sign-in link"` on `docs/spec docs/frame.md` leaves only sentences that are still true.

**P (proof).**
- **Files:** `PATH.md` (§2); `packages/relic-mcp/PATH.md` (a mirrored section); `relic-mcp/test/{email-code-sign-in-steps.ts, email-code-sign-in-path.ts, email-code-sign-in-live-probe.ts}` (new, modelled on `passkey-sign-in-path.ts:54-209` with `callMcp` and `launchProofBrowser` from `decision-proof-steps.ts:88,159`); a `.github/workflows/verify.yml` step after line 109: `- name: Email code sign-in path` / `run: RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/email-code-sign-in-path.ts`.
- **Change:**
  - The fake mailer is `send: async (to, link, code) => { const m = signInMail(link, code); mails.push({to, link, code, subject: m.subject, text: m.text}); }`.
  - The browser path types the code with CDP `Input.insertText` into a focused `[data-sign-in-code-input]`.
  - The negative checks go over HTTP with a manual cookie jar, using a distinct address for each scenario. Default limits apply (fewer than 30 submissions).
  - The live probe uses a plus-tagged `+relic-code-<runId>` address from `RELIC_EMAIL_CODE_PROBE_MAILBOX` and runs no extra-mail negatives.
- **Acceptance:**
  - On the integrated branch, the command prints every §2 line and exits 0.
  - With step 8's `consumeAuthLink` call removed in a scratch copy, it fails at STEP_5.

## 7. Verification and security review (main agent, after integration)

1. In a fresh worktree run `bun install --frozen-lockfile`, then `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify`.
2. Build `relic-mcp`, then run the new PATH command plus every proof step in `verify.yml`. The sign-in flow changed under all of them.
3. Mutation proofs in a scratch copy:
   - drop the consume → STEP_5 fails
   - `reserve` always returns true → the lockout and concurrency tests fail, and `locked=401` fails
   - revert to the unconditional `remove` → the two-instance consume test fails
4. Rendered proof in an owned headless shell: composer sent state, dashboard, offer card and decision sent step at 390×844 and 1280×900, light and dark. Check `scrollWidth ≤ clientWidth`, no clipped labels, and compare against the mock.
5. Run the `security-reviewer` before merging. Checklist:
   - the cookie's attributes and path
   - CSRF and login CSRF
   - the nonce-keyed HMAC and domain separation
   - the uniform 401 on every branch
   - charge-before-compare and fail-closed CAS
   - the conditional link delete
   - `clientIp`-keyed limiting
   - no fragment or address on the code request
   - unbiased code generation
   - constant-time compare
   - no code or nonce in logs
   - accuracy of the `/policy` text
6. After the CI deploy:
   - compare `/assets` byte-for-byte with a clean build at the deployed commit
   - grep the served `viewer.js` for `Code from the email`
   - run the live probe per `prove-relic-email-feature-on-production`, reading the code with advanced-gmail
   - clean up the scratch state
   - update that skill's "Your Relic sign-in link" subject reference

## 8. What would prove this spec wrong

- **Chrome refuses the cookie.** If it doesn't store or send `Secure; SameSite=Strict; Path=/api/auth/code` on http://localhost, STEP_3 would fail. [INFERENCE] It's fine, because `relic_session` is Secure and works in the passkey proof, `passkey-sign-in-path.ts:73`.
- **GCS overwrites don't reset object age.** The bucket isn't versioned (`resource.google_storage_bucket.relics.tf:62-64`), but if age isn't reset on overwrite, the budget rows could vanish mid-window. [INFERENCE]
- **GCS rate-limits bursts on one object with errors other than 412.** That would turn bursts into 500s, which is safe but noisy. [INFERENCE]
- **The bundler re-splits chunks.** If `shell-budget` or the service-worker tests move, the injection boundary in §1.7 was violated.

## 9. Needs Jason (ask both in one batch)

**Q1. May a session started by a typed code add the address's first passkey, the way a link-started session can within 15 minutes?** My recommendation is **Yes**.
- **Why:** a code proves the same thing a link does: control of that mailbox, minutes ago. Guessing is bounded at 1 in 100,000 per targeted address per day, and each day costs the guesser an email to the target. The passkey-added email still fires.
- **If No:**
  - the code response sets no offer marker
  - `mayAddFirstPasskey`, §4.10, the V2 copy, the codes in the offer card and decision panel, and the changes to the first-passkey parts of `/policy` and `mail.ts` are all dropped
  - V1's `requestFreshLink` returns no `codeEntry` and keeps the old `KEY_AT_RISK_NOTE` for its own warning
  - PATH prints `offer=absent`
  - the docs say a code session cannot add a first passkey

**Q2. Should a code work only in the browser that asked for it?** My recommendation is **Yes**.
- **Why:** it keeps codes impossible to test offline from the bucket without a new secret, makes a code seen on a lock screen or over a shoulder useless anywhere else, and lets every failure give one answer.
- **The cost:** someone who asks on a laptop can't type the code into a phone browser. They tap the link there instead.
- **If No:** checking codes by address needs a server-held key that you would create by hand in Secret Manager (CI can't create secrets, `locals.tf:41-53`), and the endpoint would need padding so it doesn't reveal pending sign-ins. That changes the shape of §4.1 through §4.4, so it needs a new plan before dispatch.