# Direct share and invitations: dispatch spec

This is the original direct-share dispatch spec. The grant and claim storage, rollback, coverage and lifecycle contracts below were updated for the grant-race fix; the initial grounding and decisions remain historical.

- **Grounding.** Everything below was read at `origin/main` 56482913, which had not moved when I checked. The reads came from read-only snapshots: the scratch worktree, then a `git archive` export into `$TMPDIR`. Both are gone. Line numbers are from that commit. Workers rebase on `origin/main` and find anchors by symbol.
- **Spelling.** Product copy says "relik" or "Relik". Identifiers, paths, package names, tool names and protocol labels keep `relic`. The guard is `packages/relic-viewer/test/brand-spelling.test.ts`.
- **No em dash and no en dash anywhere.**

## 0. Goal

When this is done:

1. **Share by address.** In the Access panel of a private relik, the owner types addresses and sees each fingerprint. The owner picks versions and taps the passkey once. From then on, each registered person opens those versions and every later version without asking, and gets one email with the keyless link.
2. **Grant signers while asking them to sign.** When the owner names a private signer who cannot open the relik yet, the same "Send with passkey" tap grants them access and sends the request.
3. **Invite an address with no key yet.** The same Share tap creates an invitation for an address that has no private-share key.
   - The invitation is a link holding a temporary key for the versions the owner picked.
   - It opens only for someone who proves that address with a sign-in code or link.
   - It expires after 7 days by default; the owner can choose 1 to 30.
   - The invitee reads the versions at once. "Keep access" sets up their passkey, re-wraps the keys to their own key and uses up the invitation.
   - The owner then confirms with one tap so they can open later versions.
   - Relik emails the invitee a notice naming the owner. The owner sends the link itself, because it holds a key.
4. **relic-mcp cannot grant or invite.** It returns a link that opens the owner's Share form with the addresses filled in.
5. **The request path is unchanged.**

## 1. Corrections to the brief (with evidence)

1. **A lookup by email already exists, and any identity holder can use it.** `POST /api/identity/recovery/lookup` returns `PartyJSON` for an address (`app.ts:1070-1080`, `private/identity.ts:367-383`). The only limit is 30 per viewer per instance (`config.ts:303`), and the behaviour is disclosed (`service.md:756`, `decisions.md:1219`). So an owner-only lookup does not shrink the oracle. One shared budget bounds it (3.5).
2. **One attestation cannot cover both grants and a signing request without breaking certificates.** The certificate verifier rebuilds the request challenge from the single `signing_request` statement (`relic-format/src/signing.ts:1099-1122`). It also parses the proof with an exact set of keys (`:1473-1495`). Resolved by D1a.
3. **`grant` signs exactly one statement today.** The kind count is exact (`private/attest.ts:277-283`). The challenge already commits to N statements under one nonce (`relic-format/src/private.ts:463-480`, `relic-viewer/src/private/keys.ts:574-633`). A batch only needs the purpose to allow repeats (3.4).
4. **`grantJson` serves `statements[0]` for every row** (`relic.ts:108-118`). Both verifiers refuse an unverifiable live grant: the browser's `rosterGrants` (`rekey.ts:393-440`) and relic-mcp's `verifyGrant` (`relic-mcp/src/private.ts:323-392`). Each row must be served its own grantee's statement, or every later seal fails.
5. **Code names.** relic-mcp refuses with `recipient_forged_grant` (`relic-mcp/src/signing.ts:163-184`). The server code is `signer_without_access` (`signing.ts:405-435`). `signer_without_grant` is only a label in a proof receipt (`signing-path.ts:919`).
6. **The composer cannot add the owner as a private signer** (`signing/controller.ts:300-334`, `composer.ts:271-285`). The server exempts the owner from that check (`signing.ts:418`). S2 fixes the composer.
7. **Existing grant defects.** S1 fixes all three in its shared core:
   - a grant to the owner's own identity is accepted (`relic.ts:372-386`);
   - `putGrant`'s create-only `false` return is ignored (`relic.ts:468-472`, `store.ts:2104-2109`);
   - rollback deletes every wrap for the key, including a concurrent winner's (`relic.ts:448-461`).
8. **Only the owner has an access log** (`gcsstore.ts:2342-2350`). Recipients see the relik under "Shared with you" (`identity.ts:655-667`).
9. **`format.md:487` has been stale since 2026-11-24.** It says the owner types the fingerprint. The lookup still returns no fingerprint field.
10. **Relik cannot send an invitation link.** The link must carry the invite private key, and Relik mail never carries a key (owner decision 4; the zero-knowledge statement in `service.md` section 10). So the owner's browser composes the invitation email and the owner sends it, as with public reliks (`composeShareEmail`, `relic-format/src/share.ts:82-115`). Relik's notice names the owner and carries no link (D12).
11. **A grant row that installed verifiers cannot parse blocks them.**
    - relic-mcp builds every seal's recipient set from `/recipients` and rethrows on any live grant that fails `verifyGrant` (`relic-mcp/src/private.ts:441-457`).
    - `verifyGrant` parses the statement as `grant` first (`:332-335`), so an unknown shape throws.
    - The same throw blocks `relic_request_signatures` (`relic-mcp/src/signing.ts:155-162`). The browser's `rosterGrants` throws the same way (`rekey.ts:426-437`).
    - So a "grant from invite" row would block private republish, rekey and signing on that relik for every installed relic-mcp. Releasing a new relic-mcp first does not fix copies already installed.
    - Invitations and claims therefore never appear in `/recipients` (4.2).
12. **A new role gets comments and decisions by default.** `privateReach` refuses only `none`, `requested`, `declined` and `revoked` (`app.ts:3818-3825`). Signing (`signing.ts:737-742`) and `privateAccessView` (`relic.ts:160-195`) use allow-lists. The surfaces of the new `invited` role are decided explicitly (D14) and tested.
13. **Lifetime extension and erasure name their object families one by one.** Each new family is added to, or deliberately left out of, each of these (4.3):
    - `extendPrivateLifetime` (`gcsstore.ts:702-762`);
    - the bucket rule's prefixes (`deploy/terraform/modules/relic/resource.google_storage_bucket.relics.tf:37-64`);
    - the owner and operator delete sweeps (`relic.ts:1136-1160`, `app.ts:3674-3694`);
    - version deletion (`relic.ts:1191-1199`).
14. **A first passkey needs a fresh sign-in.** Creating the first passkey for an address accepts only a link or code session younger than 900 s (`identity.ts:75-85`, decisions 2026-10-25). An invitee who reads for longer before "Keep access" is asked for a new code.
15. **Creating an invitation would be a cheaper registration oracle than the lookup.** Refusing an invitation to an address that has a key answers "is this address registered". Each invitation is therefore charged to the lookup budgets before that check (3.5).
16. **WebCrypto cannot derive a P-256 public key from a private scalar** (`decisions.md:1200`). So the invitee imports the invite key as a JWK, with `d` from the link and `x`, `y` from the owner-signed invitation. A mismatch fails at HPKE decap, because DHKEM binds the recipient public key into the KEM context (`relic-format/src/hpke.ts:31-34`, `:133`).

## 2. Decisions

**Settled by the owner for invitations:**

1. **Bound to the address.** The opener proves the invited address with the existing sign-in code or link. A leaked link alone opens nothing.
2. **Used once.** After the invitee registers a passkey and claims, the invitation is used up. Before that, the same address can reopen it until it expires.
3. **Lifetime.** 7 days by default; the owner may choose 1 to 30.
4. **Notice mail.** It names the owner's address, and never the title, the file name or any key.

**D1 to D11 were accepted as recommended:**

| # | Decision |
|---|---|
| D1 | (a) The signing tap authorizes grants to exactly the signers it names. |
| D2 | (a) The direct-share email names the owner and shows the recipient's fingerprint. |
| D3 | Budgets are per instance and charged per address: lookups 30/h per identity, shared with the recovery lookup, plus 120/h per IP; direct grants 60/h per owner. |
| D4 | The Access panel offers every sealed version, with the current one locked on. The composer grants the request version only. |
| D5 | One email per newly granted signer. |
| D6 | The link relic-mcp returns is prefilled through the fragment. |
| D7 | Re-sharing with a revoked reader is allowed. |
| D8 | The `share` log kind. |
| D9 | `grant_exists` refuses the whole batch. |
| D10 | The recovery holder can be shared with. |
| D11 | A drafted keyless invitation for addresses with no key. In the panel this is superseded by D18 if D18 is accepted. |

**New decisions for the owner.** I recommend option (a) in each case, and this spec is written to it.

| # | Decision | (a) Recommended | Alternative |
|---|---|---|---|
| D12 | Who delivers the invitation | The owner sends each link from their own mailbox: "Copy link", or a draft composed in the browser. Relik emails the invitee a notice naming the owner, with no link and no key. | The notice also carries the keyless relik link, which leads to the request path. |
| D13 | What a claim gives | The claim makes the invitee a reader of the listed versions. That access is bound to their own key and outlives the invitation. The owner confirms with one tap (a direct share) so they can open later versions. Relik emails the owner on claim, and accepted invitations count on the Access button. | No claim at all. Once the invitee sets up a key, the owner shares directly, and invitation access ends at expiry. |
| D14 | What invitees can do | Before the claim: view and download the listed versions only. No comments, suggestions, decisions, signing or sharing. After the claim: comments and decisions on the listed versions. Not a signer until the owner confirms. | No comments until the owner confirms. |
| D15 | Cancelling an invitation, or removing an invitee who accepted | The owner's session is enough, with no passkey, like Decline. It grants nothing. No rekey is needed, because invitees are never in the recipient set. | One passkey tap each. |
| D16 | Revoking a different reader | Leaves open invitations alone. They cover only their listed versions, whose keys every remaining reader keeps. | Every revocation also cancels every open invitation on the relik. |
| D17 | Keeping the invitation link | Shown once in the owner's page and never stored. If it is lost, the owner cancels and invites again. | Keep links in the owner's browser until they are claimed. |
| D18 | Addresses with no key in the Share section | Invite them by default, in the same tap, with a lifetime picker defaulting to 7 days. This replaces D11's keyless draft in the panel. `relic_share` keeps its keyless draft for agents. | Show D11's draft next to invitations. |
| D19 | The claim tap | No extra tap. The claim is signed by the invitee's key, which was unlocked by the tap that set it up, as an opened receipt is. | A passkey-attested claim: one more tap, matching access requests. |
| D20 | Limits | At most 50 open invitations per relik. Each invitation draws one unit from the lookup budgets and one from the direct-share budget. Opening, key fetch, mint and claim share 240 calls per hour per IP. | Other numbers. |
| D21 | Receipts | Key fetches through an invitation write no delivered receipt; the owner's log records each one with the address. Normal receipts apply after the claim. | A receipt keyed by invitation. |

## 3. Shared contracts

### 3.1 C0: the format contract

C0 is dispatched first. S1, S2 and S3 start from it.

**`relic-format/src/private.ts`**

- `export const PRIVATE_SHARE_MAX_GRANTS = 20;`
- Two new statement kinds. Each gets `StatementKind`, `StatementMap`, `SPECS`, known-answer fixtures in the tests, and a row in the `format.md` 3.17 table.
  - `invite`: `{at: AT, expires_at: integer, invite_public_key: PUBLIC_KEY, invited_email: EMAIL, owner_identity_id: HEX_ID, relic_id: RELIC_ID, versions: versionList(true)}`. Cross-check: `expires_at > at`. Signed by the owner identity and attested by WebAuthn, inside the `grant` purpose.
  - `invite_claim`: `{at: AT, claimant_identity_id: HEX_ID, invite_id: HEX_ID, relic_id: RELIC_ID, versions: versionList(true)}`. Signed by the claimant identity and not attested, like `open_receipt`.
- New helpers:
  - `inviteIdOf(pub)`: lowercase hex of `kemKeyIdOf(pub)`.
  - `generateInviteKeyPair()`: `{publicKey: 65 bytes, d: 32 bytes}`, using WebCrypto `generateKey` with an extractable private key, exported as JWK `d`.
  - `inviteRecipient(d, publicKey)`: an `HpkeRecipient` built from the JWK `{kty:'EC', crv:'P-256', d, x, y}`.
  - `inviteFragment(d)`: returns `k=<43 base64url chars>`.
  - `parseInviteFragment(hash)`: returns a 32-byte `d`, or `undefined`.

**`relic-format/src/private-wire.ts`**

- `AccessRole` adds `'invited'`.
- `AccessEventJSON.kind` adds `'share' | 'invite' | 'claim'`, and gains `subject_email: string | null`.
- New types:

```ts
export interface InviteSummaryJSON { readonly invite_id: string; readonly expires_at: string }
export interface GrantLookupResultJSON {
  readonly email: string; readonly party: PartyJSON | null; readonly standing: AccessRole | null;
  readonly invites: readonly InviteSummaryJSON[]; // open invitations to this address, only when party is null
}
export interface GrantLookupJSON { readonly results: readonly GrantLookupResultJSON[] }
export interface InviteJSON {
  readonly invite_id: string; readonly invited_email: string; readonly versions: readonly number[];
  readonly created_at: string; readonly expires_at: string;
  readonly status: 'open' | 'claimed' | 'confirmed' | 'expired' | 'revoked';
  readonly claimed_by: PartyJSON | null; readonly claimed_at: string | null;
  readonly statement: Record<string, unknown>; readonly identity_signature: string;
}
export interface InviteOpenJSON {
  readonly relic_id: string; readonly invite_id: string; readonly status: 'open' | 'claimed' | 'expired' | 'revoked';
  readonly expires_at: string; readonly versions: readonly number[]; readonly sealed_version: number | null;
  readonly owner: PartyJSON; readonly invite: { readonly statement: Record<string, unknown>; readonly identity_signature: string };
  readonly claimed_by_identity_id: string | null;
}
export interface GrantsJSON { readonly grant: GrantJSON | null; readonly grants: readonly GrantJSON[]; readonly invites: readonly InviteJSON[] }
export interface SigningGrantJSON { readonly statement: Record<string, unknown>; readonly identity_signature: string }
```

**`relic-format/src/share.ts`**

- `composePrivateInvitation({url, to})`: the text of `relic-mcp/src/share.ts:52-73`, moved here verbatim.
- `composeInviteEmail({url, to, expiresAt})`:
  - subject: "Invitation to a private file on Relik";
  - body: "I've invited you to a private file on Relik. Open this link and confirm your address with the code Relik emails you, then set up a passkey there to keep access." / the link / "The link holds the key to the file, so don't forward it. It works until {date}."

**`relic-viewer/src/private/access-log.ts`** (`KIND_LABEL`) adds:

- `share: 'Shared directly'`
- `invite: 'Invited'`
- `claim: 'Invitation accepted'`

This keeps the typecheck green.

### 3.2 Server rows and storage

The original claim-row and wrap-rollback design in this section is superseded by the atomic invitation claim and row-based authorization in `docs/spec/service.md` section 10.4.

All of these live in `store.ts` and both store implementations.

- **`AccessEvent`** adds the kinds `share`, `invite` and `claim`, and an optional `subjectEmail`.
- **`GrantRow`** adds an optional `grantStatement` (D1a).
- **`WrapRow.source`** is `'seal' | 'grant' | 'backfill'`. Grant wraps carry the proposed commit `epoch`. Claims never write `m/wrap/`.
- **`RelicRow`** stores `accessFence`, a map from normalized address to `{epoch, nonce}`, committed with the access epoch on revocation or regrant.
- **`InviteRow`:**

```ts
{ relicId, inviteId /* hex kemKeyId of invitePublicKey */, ownerIdentityId, invitedEmail /* normalized */,
  invitePublicKey /* base64url SEC1 */, versions /* listed, minus versions deleted since */, expiresAt, createdAt, createdAccessEpoch?,
  status: 'open' | 'claimed' | 'revoked', wraps: { version, enc, ct }[] /* empty unless open */,
  claimWraps?: { version, enc, ct }[], claim?: { statement, identitySignature },
  attestation: StoredAttestation, claimedAt?, claimantIdentityId?, revokedAt? }
```

  - Key: `m/invite/{relicId}/{inviteId}.json`.
  - `customTime` follows the invitation expiry until claimed, then the relik expiry.
  - Writes are create-only, with compare-and-swap updates.
  - Methods: `putInvite`, `getInvite`, `listInvites`, `updateInvite`, `deleteInvite`, `deleteInvitesForRelic`.
  - Temporary wraps and claim wraps live inside the invitation row, not in `m/wrap/`.
- **`InviteClaimIndex`:** `{ relicId, identityId, inviteIds }` at `m/invite-claim/{relicId}/{identityId}.json`, with the relik expiry. `addInviteClaimIndex` appends idempotently before the claim CAS; `getInviteClaimIndex` reads it and `deleteInviteClaimsForRelic` removes it on relik deletion. The index is only a lookup hint. Each referenced invitation must still be claimed by that identity and must not be fenced by the relik's address cutoff.
- **`standingOf` precedence:** owner, recovery, grantee, revoked grant, invited (a live claim), revoked claim, requested, declined, none.
- **`READABLE_ROLES`** adds `invited`.
- **`privateAccessView`'s allow-lists** add `invited` for owner, settings and signing visibility.
- **The signing allow-list is unchanged,** so an invitee is never a signer.

### 3.3 Routes

"Owner session" means a session whose current identity is `ownerIdentityId` (`ownedPrivate`, `relic.ts:327-336`). "Invited session" means a session whose `normalizeEmail(session.email)` equals `InviteRow.invitedEmail`.

**A. `POST /api/relics/{id}/grants/lookup` (new, owner only).** Body: `{emails: string[]}`. Checks in order:

1. `401 sign_in_required`.
2. `400 invalid_identity` if the body is malformed.
3. Relik refusals; then `400 private_policy_violation` (`policy_check: 'version'`) for a public relik.
4. `403 owner_required`.
5. `400 invalid_identity`, with `identity_check: 'emails'`, or with `'email'` plus `index`.
6. `429 private_rate_limited`. One unit per unique address is charged to `identity-lookup`, keyed by the session address and shared with D, and to `identity-lookup-ip`. All units or none.
7. For each address: `currentIdentity` and `standingOf`, plus the open invitations to that address when it has no identity, excluding any that the address cutoff fences.

Returns 200 `GrantLookupJSON`. No access-log event, and no log line contains an address.

**B. `POST /api/relics/{id}/grants` (changed).** Body: `{attestation, wraps}`. The attestation has purpose `grant` and carries 1 to `privateShareMaxPerCall` statements, each `grant` or `invite`. Checks in order:

1. `401`, then `400 invalid_wrap` if the body is malformed.
2. Relik refusals, then `403 owner_required`.
3. Attestation refusals: `400 invalid_statement` (`shape`, `kinds`, `count`, field checks, `stale`, `relic`, `signature`), `400 invalid_passkey`, `403 passkey_verification_failed`, `409 passkey_required`.
4. **Checks that do not depend on registration,** per statement:
   - the owner (`owner_identity_id`);
   - no grantee or invited address repeated in the batch (`grantee`);
   - versions: `410 version_deleted`, `409 private_seal_required`, and `409 grant_stale_version` plus `current_version` if the current sealed version is missing;
   - for invitations:
     - `expires_at` must satisfy `<= at + 30 days` and `<= relik expiresAt`, and `>= at + 1 day` unless it equals the relik's expiry (`400 invalid_statement`, `expires_at`);
     - `invite_public_key` must import as a P-256 point, and its id must not already exist on the relik (`invite_key`);
     - `409 invite_limit_reached`.
5. **Budgets, all units or none.** `identity-lookup` and `identity-lookup-ip` are charged one unit per invitation. `directShareRateLimit`, keyed by owner identity, is charged one unit per invitation and per grant with no pending request.
6. **Checks that depend on registration.**
   - Grants: grantee unknown, retired, email mismatch or the owner (`400 invalid_statement`, `grantee`); `409 fingerprint_mismatch` plus `grantee_identity_id`; `409 grant_exists` plus `grantee_identity_id`.
   - Invitations: `409 identity_exists` plus `email` when the address now has an identity.
7. **Wraps.** The set of `(version, recipient_key_id)` pairs must equal exactly the union of grant versions times grantee KEM key and invitation versions times invite id, with no duplicates and at most `privateBackfillMaxWraps` items. Otherwise `400 invalid_wrap`.
8. **Writes.**
   - Create grant wraps at the proposed commit epoch and write grant rows, then create invitation rows with their wraps embedded. `putWrap` is create-only; `replaceWrapIf` replaces an existing wrap only if its epoch is older, using a generation check.
     The wrap primitive and deletion handling in this historical plan are superseded by `ensureWrap` and the deletion fence in `docs/spec/service.md` section 10.4.
   - If the batch has grants, compare the relik epoch with the starting epoch and advance it in one update. A regrant writes the address fence in that same update. On failure, created invitation rows are deleted and grant rows are rolled back only while their attestation nonce still matches. Wrap objects are not deleted by rollback. A lost response can cause rollback even when the epoch commit landed, failing closed.
   - A batch of invitations only changes no epoch. Each invitation records the access epoch observed by the call; later authorization checks apply the current address fence.

Returns 201 `GrantsJSON`. After success:

- each grant gets its request row updated, a log event and email (3.6, 3.7);
- each invitation gets an `invite` event and the notice.

**C. `POST /api/relics/{id}/signing/requests` (changed, browser path).** The body adds `grants?: SigningGrantJSON[]` and `wraps?: WrapJSON[]`, within the 65,536-byte cap. Order:

1. The existing prefix and authorization.
2. `400 invalid_statement` (`grants`) for grants on a public relik, on the device path, or not given as an array.
3. The request preflight: today's checks that do not depend on standing.
4. Each grant must be fresh, signed by the owner identity, for this relik and owner, with `versions == [request version]`, and its grantee must be a signer other than the owner, with the same id and normalized email. Then the grant checks from B apply.
5. Wraps: exactly one per grant, for the request version.
6. Budget.
7. Apply the grants. If the compare-and-swap fails: `409 grant_stale_version`, and no request is made.
8. Re-read the row, then check signer standing and write the request as today.
9. Any refusal after the grants applied carries `granted: string[]`.

Returns 201 `SigningRequestJSON`, unchanged.

**D. `POST /api/identity/recovery/lookup`.** Only the budgets change: it now also charges `identity-lookup-ip`, alongside the existing per-viewer budget shared with A. The response is unchanged.

**E. `GET /api/relics/{id}/invites` (new, owner only).** Returns 200 `{invites: InviteJSON[]}`.

- `revoked` takes precedence when the relik's address cutoff fences the invitation, even if its stored status still says open or claimed.
- `expired` is computed for an open row past its expiry.
- `confirmed` is computed for a claimed row whose claimant holds a live grant.

**F. `POST /api/relics/{id}/invites/{inviteId}/revoke` (new, owner only, no tap, D15).** Body: `{}`. Refusals: `401`, `403 owner_required`, `404 invite_not_found`. Then, by status:

- **open or expired:** compare-and-swap to `revoked`, wraps emptied.
- **claimed:**
  - If the claimant holds a live grant: `409 grant_exists` (revoke the reader instead).
  - Otherwise compare-and-swap the invitation to `revoked`, emptying both the temporary and claim wraps. Its index entry may remain but grants no access.
- **revoked or fenced by the cutoff:** 200, as a repeat; the update also clears any wraps left on the row.

Each change logs `revoke` with `subject_email`. Returns 200 `{invite: InviteJSON}`.

**G. `POST /api/relics/{id}/invites/{inviteId}/open` (new, invited session).** Checks:

1. `401`.
2. `429` (the `invite` per-IP budget).
3. Relik refusals.
4. `404 invite_not_found` when there is no row, or the session address is a different address. The two cases get the same answer.

Returns 200 `InviteOpenJSON`. For an expired or otherwise non-open row the server can clear remaining temporary wraps lazily. A cutoff-fenced row is returned as revoked with empty wraps in the response; that effective status alone does not persist cleanup.

**H. `POST /api/relics/{id}/versions/{v}/key` with body `{invite_id}` (new branch, `app.ts:1329-1355`).** Requires an invited session and the invite budget. Every failure returns `403 private_access_denied`:

- no row, or a different address;
- the invitation is not open, has expired, or is fenced by the address cutoff;
- the version is not listed, or is deleted, or is not sealed.

Returns `KeyJSON` with `wrap.recipient_key_id = invite_id`. Logs `wrap_fetch` with the actor's email and `subject_email`. Writes no receipt (D21).

**I. The private mint with body `{invite_id, version}`** (`mintPrivate`, `app.ts:1396-1486`). The same gate and refusal as H. URL validity is capped at the invitation's and the relik's expiry, and the download cap applies.

**J. `POST /api/relics/{id}/invites/{inviteId}/claim` (new, invited session).** Body: `{statement, identity_signature, wraps}`. Checks in order:

1. `401`, then the invite budget.
2. `400 invalid_statement` if the body is malformed.
3. Relik refusals.
4. `404 invite_not_found`.
5. An invitation already revoked or fenced by the address cutoff returns `410 invite_revoked`; an open invitation past expiry returns `410 invite_expired`.
6. `409 identity_required` if the address has no current identity.
7. The statement: parsed; signed by that identity's key (`signature`); `claimant_identity_id` is that identity and `invite_id` matches (`claim`); `relic_id` (`relic`); `versions` equal the row's (`claim`); fresh (`stale`).
8. A claimed invitation returns the existing result to the same identity, or `409 invite_claimed` to a different identity.
9. Determine which invited versions are covered by a live grant and have an ordinary wrap for the identity. If all are covered, use the invitation CAS below with no claim wraps or index entry and return 200 `{status:'already_reader'}`.
10. Otherwise validate exactly the row's versions times the claimant's KEM key (`400 invalid_wrap`), then add the invitation id to the identity's claim index.
11. Compare-and-swap the invitation from `open` to `claimed`, storing the signed claim and the claimant wraps for versions not already covered, together with `claimantIdentityId` and `claimedAt`, and emptying the temporary wraps. A revoked row returns `410 invite_revoked`, a different claimant returns `409 invite_claimed`, expiry returns `410 invite_expired`, and changed versions return `400 invalid_statement` with `statement_check: 'claim'`. A same-identity winner is treated as a successful repeat.
12. Reread the relik and refuse with `410 invite_revoked` if its cutoff now fences the claimed row. Then recheck the current identity. If it changed after the CAS, return `409 identity_changed`; the invitation remains consumed by the old identity.
13. Log `claim` whenever the invitation changes state. Email the owner unless every invited version was already covered by a live grant and ordinary wrap.

Returns 201 `{status:'claimed', versions}`.

### 3.4 Attestation and authority

- **The `grant` purpose now allows repeated, mixed statements.** `PURPOSE_REPEAT = { grant: { kinds: ['grant', 'invite'], max: PRIVATE_SHARE_MAX_GRANTS } }` in `attest.ts`. Every other purpose keeps its exact count. The nonce stays single-use and bound to purpose, relik and address. Every statement is still checked for freshness and relik.
- **`grantJson` serves each grantee its own statement.** It uses `grantStatement` if present. Otherwise it uses the stored `grant` statement whose grantee matches, and never falls back to the first statement.
- **`verifyStoredGrant` covers both forms.** For a signing-route grant, the request must name the grantee with `[version]`.
- **An invitation is the owner's signed, attested authorization** for one address and the listed versions, valid until `expires_at`.
- **A claim moves that authorization from the bearer key to the claimant's identity key.** The scope stays exactly what the owner signed. Later versions need a normal owner-signed `grant`.
- **relic-mcp can create neither grants nor invitations.** Both need an owner passkey assertion and owner-identity signatures, and an invite private key must never pass through a transcript.

### 3.5 Problem codes, configuration, budgets

**New codes:**

| Code | Status | Title |
|---|---|---|
| `grant_exists` | 409 | "This person can already read this relik" |
| `invite_not_found` | 404 | "No such invitation" |
| `invite_claimed` | 409 | "This invitation was already used" |
| `invite_expired` | 410 | "This invitation expired" |
| `invite_revoked` | 410 | "This invitation was withdrawn" |
| `invite_limit_reached` | 409 | "This relik has too many open invitations" |

**Reused codes:** `identity_exists` (with `email`), `identity_required`, `private_access_denied`.

**New extensions:**

- `grantee_identity_id`;
- `granted`;
- `statement_check` values `count`, `grants`, `grantee`, `expires_at`, `invite_key`, `claim`;
- `identity_check` values `emails` and `email`, with `index`.

**Configuration,** each checked in `assertConfig`:

```
privateShareMaxPerCall: 20 (1 to 20)
identityLookupIpRateLimit: {120, 3600}
directShareRateLimit: {60, 3600}
inviteDefaultDays: 7, inviteMinDays: 1, inviteMaxDays: 30
privateInvitesMaxOpen: 50
inviteRateLimit: {240, 3600}
```

`identityLookupRateLimit` stays `{30, 3600}`, but now counts addresses rather than calls.

**Limiter:** `RateLimiter.check(units)` charges all units or none. `PrivateEnv.limit(..., units)` and `limitEach` peek every budget before charging any.

### 3.6 Email

- **`directShareMail`** (D2a). Subject: `{owner} shared a relik with you`. It names the owner and includes the recipient's fingerprint.
- **`inviteNoticeMail`.**
  - Subject: `{owner} invited you to a relik`.
  - Paragraph 1: "{owner} invited you to open a private relik on Relik."
  - Paragraph 2: "They'll send you the link themselves: it holds the key, and Relik never has it. The link opens only after you confirm this address, and it works until {date}."
  - Paragraph 3: "If you don't know {owner}, ignore this email."
  - No link.
- **`inviteClaimedMail`,** to the owner.
  - Subject: `{address} accepted your invitation`.
  - Body: "{address} accepted your invitation to a relik on Relik. They can open the versions you invited them to." / "To let them open later versions too, confirm in Access: {origin}/{id}?access=invites".
- **`accessGrantedMail` is unchanged** for grants that answer a pending request.
- **None of these emails** names the title or the file, or carries a fragment or a key.
- **Access emails ignore the notifications setting and the stop list,** as grant email does today (`relic.ts:503-512`, `decisions.md:1329`).
- **Delivery failures are logged without the address.**

### 3.7 Access log

| Kind | Actor | Subject |
|---|---|---|
| `share` | owner | grantee (no pending request) |
| `grant` | owner | grantee who had a pending request |
| `invite` | owner | `subject_email`, with the highest version listed |
| `wrap_fetch` through an invitation | actor email = the invited address | `subject_email` |
| `claim` | the claimant's identity and email | `subject_identity_id` and `subject_email` |
| `revoke` | owner | an invitation cancelled or an invitee removed; `subject_email`, plus `subject_identity_id` if they had claimed |

Lookups append nothing.

### 3.8 Viewer hooks and copy (S0 freezes them, S2 implements them, S4 asserts them)

**Share section** (the attributes from the earlier version stay):

- a new row state, `data-share-state="unregistered"`, carries `input[data-share-invite]` (checked by default) and `select[data-invite-days]` (1 to 30, default 7, capped at the relik's expiry).
- Row copy: "{email} hasn't set up a private-share key. Invite them: they confirm this address, then set up a passkey to keep access."
- A row with an open invitation is unchecked by default, with the copy "Invited {date}, open until {date}."
- `invited` state: "Accepted your invitation. Sharing lets them open later versions."

**After the tap,** `section[data-invite-links]`:

- one `[data-invite-link="<inviteId>"]` per invitation, with `[data-action="invite-copy"]` and `[data-action="invite-draft"]` (`mailto:` built with `composeInviteEmail`);
- copy: "Send each invitation yourself. Each link holds a key, so Relik can't send it. Relik emails each person that you invited them, without the link. Each link is shown once."
- copy: "Anyone with a link and that person's mailbox can open it until it expires or is used."

**Invitations section,** `section[data-invites-section]`:

- rows are `[data-invite="<inviteId>"][data-invite-state="open|claimed|expired|revoked"]`;
- open: `[data-action="invite-cancel"]`;
- claimed: `[data-action="invite-remove"]`, plus a checkbox and `[data-fingerprint="claimant"]`;
- `[data-action="invite-confirm"]` ("Confirm with passkey") runs route B with grant statements for the checked claimants, over all sealed versions by default;
- expired: `[data-action="invite-again"]` fills in the Share section.

The Access button count is pending requests plus accepted invitations.

**Invitee states** (`data-private-state`) and their copy:

| State | Copy |
|---|---|
| `invite-signin` | "You're invited to a private relik" / "This invitation opens only for the address it was sent to. Sign in with that address. Relik emails it a code." / "Use the code. If you use the link in that email instead, open this invitation again afterwards." |
| `invite-key-missing` | "This invitation link is incomplete. Open the link from the email again." |
| `invite-wrong-address` | "This invitation doesn't open for {address}. Sign in with the address it was sent to." |
| `invite-ready` | Banner `[data-invite-banner]`: "{owner} invited you. You can open {versions} until {date}." + `[data-action="invite-keep"]` ("Keep access"). The file renders below. |
| `invite-claimed` | "You'll keep access to {versions}. When {owner} confirms, you'll also get later versions." |
| `invite-expired` | "This invitation expired on {date}. Ask {owner} to send a new one." If the address has an identity, also `[data-action="private-request"]`. |
| `invite-withdrawn` | "{owner} withdrew this invitation." |
| `invite-used` | "This invitation was already used." |
| `invite-damaged` | "This invitation link doesn't open. Ask {owner} to send it again." |

**Composer rows:** `data-signer-access` adds a note for invitation-only addresses: "{email} has an invitation but hasn't set up a private-share key, so they can't sign yet."

### 3.9 relic-mcp

- **`relic_share` on a private relik** validates 1 to 20 addresses, makes no service call, and returns `grant_url = {origin}/{id}?access=share#to=<addresses, percent-encoded>` beside the keyless draft.
- **Description, added:** "For a private relik, relic_share grants and invites nothing, because both need the owner's passkey: it returns grant_url, which opens the owner's Share form in their browser with these addresses filled in. Relik looks each one up; the owner grants registered addresses and invites the rest with one passkey tap, and sends each invitation link from their own mailbox because it holds a key. This call sends nothing to the service."
- **`relic_request_signatures`** refuses with `recipient_forged_grant` and the message "{email} can't open this relik yet, so they can't be asked to sign. Grant access or invite them first: open grant_url in your browser and tap your passkey. An invited person can sign once they accept and you confirm." Details: `{signer_email, grant_url}`.
- **`INSTRUCTIONS` item 11:** "Private reliks (private: true) carry no key; each reader needs the owner's grant or invitation, made in the browser with one passkey tap. No tool can grant or invite: relic_share returns grant_url for the owner. Setup: relic_enroll_device, then relic_confirm_device."
- **`relic_describe_client` `sharing`:** add "on a private relik, relic_share composes grant_url for the owner's browser; grants and invitations always need the owner's passkey."
- **Release:** bump the version, then push the tag after merge (`docs/release.md`).

### 3.10 The path, and the proof that already exists

**The path:**

- **Direct share:** lookup → owner panel → one tap → `fetchVersionKey` → wraps → B → email → open.
- **Invitations:** B with invitation statements → the owner sends the link → the invitee signs in with a code → G, H, I → reading → setup → J → the owner's email → confirm (B) → later seals include them.
- **Signing:** route C.
- **relic-mcp:** `grant_url`.

**Proof that exists today:** `private-shares-path.ts`, `signing-path.ts` and `settings-path.ts`, each with two instances, a shared store, captured email and virtual authenticators (`verify.yml:163-168`). The private unit suites cover the rest. There are also `gcsstore.test.ts` with `fake-gcs.ts`, and a "Validate Terraform" step.

**Blind spots:** real passkeys and PRF, real email delivery, production GCS lifecycle timing, and budgets across instances.

## 4. Behaviour rules

### 4.1 Direct share

1. **Versions.** The panel offers sealed, undeleted versions, with the current one locked on. Later versions reach live grantees at each seal (`access.ts:66-96`).
2. **A repeat is refused whole** with `grant_exists`.
3. **A revoked reader** is re-shared through a compare-and-swap that requires the row to still be revoked.
4. **Retired identities** are never returned, and are refused.
5. **The owner's own address** shows "That's you" and is refused.
6. **The recovery holder can be shared with.**
7. **Writes and races.**
   - Validate everything, then write owner-supplied wraps and rows. Grant wraps use the proposed epoch; create-only writes and conditional replacement protect a newer wrap. A batch with grants advances the epoch and fences regranted addresses in the same compare-and-swap.
   - On failure, delete created invitation rows and roll back grant rows only while their attestation nonce still belongs to this call. Never delete wrap objects on a failure path. A lost commit response also takes this rollback path even if the commit landed.
     The 2026-11-26 decision adds an exception: a crossed owner deletion removes this grant's wrap pairs for the deleted version or relik.
   - A stored wrap is served only when the current grant or other role covers that version, regardless of its source. Partial grants do not create coverage gaps on versions they do not cover.
8. **Enumeration.** The answer is the owner's by design. Every refusal before the read is independent of which addresses are registered, and budgets are charged per address.

### 4.2 Invitations

**Cryptography (owner's browser).**

- For each address: `generateInviteKeyPair()`, then `wrapVersionKey` for each listed version with `recipientPublicKey` set to the invite key. That is the existing format, with the AAD equal to the invite id.
- The link is `{origin}/{id}?invite={inviteId}#k={d}`.
- `d` exists only in the owner's page memory and in the link (D17). No request, log line or Relik email ever contains it.

**Cryptography (invitee's browser).**

- At mount it reads `#k=` once and strips it with `deps.stripFragment`.
- It calls G.
- It verifies the `invite` statement under the owner's key, and pins the owner at first open, as any private reader does.
- It checks that the statement names this relik, this invite id, and the listed versions.
- It builds `inviteRecipient(d, statement.invite_public_key)`.
- For each version: `unwrapVersionKey`, then the same seal, key-commitment, owner-pin and ciphertext checks as `verifyVersionKey` (`open.ts:349-441`).

**What the service checks before serving a wrap or ciphertext:**

1. a session for the invited address;
2. the relik is live and private;
3. the invitation is `open` and unexpired;
4. the version is listed, undeleted and sealed.

Every miss returns the same refusal (H, I).

**Claim models compared:**

| | (A) "grant from invite" rows | **(B) claim, then owner confirms (chosen)** | (C) no claim |
|---|---|---|---|
| Only the owner grants | Weakened: a durable grant the owner never saw | Held: invitation scope only; the owner signs later versions with the claimant's fingerprint in view | Held |
| Installed relic-mcp and verifiers | **Broken** (correction 11) | Unaffected: `/recipients` is unchanged | Unaffected |
| Later versions | Automatic | After one owner tap | After an owner share |
| Invitation consumed with keys moved to the invitee's own key | Yes | Yes | No |

**The claim, in more detail.**

- The claim requires the address's current identity.
- If the address had no identity, the browser runs the existing setup first: create a passkey if needed, then `registerOnce` (viewer `identity.ts:73-130`). If it already had one, the browser runs `unlock`.
- The browser then signs `invite_claim` with that identity (D19), re-wraps each listed version key to its own KEM key, and posts J.
- A claimant without a grant has standing `invited`. They read through their live claim wraps, comment and decide on those versions (D14), and are never in R. A live grant takes precedence and can coexist with a live claim; a revoked grant blocks claim access.
- **Confirming is a direct share** (route B, or route C when they are named as a signer). The invitation and claim wraps remain; readable versions are the union of the grant and live claimed invitations.

**What happens to an invitation in each case:**

- **Revoke.** Cancelling or removing an accepted invitee marks the invitation revoked and clears both wrap arrays. Revoking a confirmed claimant marks the grant, then commits the new epoch, version and per-address `{epoch, nonce}` fence on the relik row. A failed or lost commit response is resolved by reading the fence nonce; an unchanged epoch allows the nonce-owned mark to be restored. Cleanup of older matching invitations and ordinary wraps is best effort. Conditional wrap deletion covers epochs at or before the revocation commit, so a newer replacement survives. A later regrant writes its own fence and does not revive older claims.
- **Rekey because a different reader was revoked** (D16). Open invitations keep their listed, older versions. No invitation covers the new version.
- **Republish.** An invitation never covers versions sealed after it. A claimant gets later versions only after confirmation.
- **Version deletion** removes those versions and both temporary and claimant wraps from each invitation. An open invitation left with no versions becomes `revoked`.
- **Signing.** An invitation-only address is not a signer. A claimant becomes one when the composer grants them (D1a), which also confirms them.
- **Recovery holder.** The recovery holder always has an identity, so cannot be invited (`identity_exists`). Recovery and grantee roles may coexist. Claim wraps are on their invitation rows and are not touched by `m/wrap/` sweeps.
- **Replay and two tabs.** The invitation compare-and-swap admits one claimant. A repeat by that identity returns the existing result without changing the winning wraps; a different claimant gets `invite_claimed`, and a cancel that wins gives `invite_revoked`.
- **After expiry,** an unclaimed invitation reports `expired`, H and I refuse, and J returns `410 invite_expired`. A claimed invitation and its claimant wraps continue for the relik lifetime (4.3), until the owner revokes that address's access.
- **A different address** gets the uniform `404`. Invitations cannot be moved to another address.
- **An identity that already exists.**
  - At claim time: the server binds to `currentIdentity` for the invited address. An `already_reader` result requires a live grant and an ordinary identity wrap for every invited version. Otherwise the claim keeps wraps for versions the grant does not cover or whose ordinary wrap is missing.
  - At claim time: the server binds to `currentIdentity` for the invited address. If that identity already holds a live grant, the invitation is marked claimed with no claim wraps or index entry.
- **Enumeration.**
  - A link holder without the mailbox sees `401` or the uniform `404`, and never learns the address.
  - A mailbox holder without the link learns only the notice.
  - Sign-in throttles are unchanged (`auth-code` per IP, 10 attempts per address per day). The invite page never shows the address.
  - Creating an invitation is charged to the lookup budgets (correction 15).

### 4.3 Storage lifecycle: every object family and its sweep

| Family | `customTime` | Bucket rule prefix | `extendPrivateLifetime` | Owner deletes the whole relik / operator delete | Version delete | Cancel / remove | Claim | Expiry |
|---|---|---|---|---|---|---|---|---|
| `m/invite/{relik}/{id}` | invitation expiry until claimed, then relik expiry | `invite/` | claimed or previously claimed rows only | `deleteInvitesForRelic` on both | strip versions and both wrap arrays; empty and open becomes `revoked` | direct cancellation clears both arrays; grant revocation fences older rows on the relik first, then attempts the same cleanup | signed claim and retained wraps committed in invitation CAS | unclaimed access refused at expiry; lifecycle erases after `customTime` |
| `m/invite-claim/{relik}/{identity}` | relik expiry | `invite-claim/` | included | `deleteInviteClaimsForRelic` on both | unchanged; no version data | retained, without authority | add invitation id before the CAS, unless the claim stores no wraps | with the relik |
| `m/wrap/` | relik expiry | existing | included | existing | deleted for the version | grant revocation attempts to sweep the key unless another recipient role retains it | never written by a claim | with the relik |
| `m/access/` (`invite`, `claim`, `share` events) | retention | existing | n/a | survive (existing) | n/a | n/a | n/a | retention |
| Sign-in codes and sessions | existing transient | existing | n/a | n/a | n/a | n/a | n/a | existing |

Two families keep no rows: invite notices (email only) and limiter counters (memory). Soft-delete retention applies to every erasure, as it does today.

## 5. What people see

### 5.1 Direct share

The recipient receives the email. They sign in, see "You have access" with no request state, open the relik, and later find it under "Shared with you". The owner's log shows "Shared directly".

### 5.2 Invitee

1. **Email.** The owner's email carries the link. Relik's notice names the owner and has no link.
2. **Opening the link.** It moves to `invite-signin`, or to `invite-key-missing` if the fragment is gone.
3. **Sign-in by code.** A link sign-in leaves the page, so the invitee reopens the invitation from the email.
4. **Reading.** G, then `invite-ready`: the file, the banner, view and download only (D14), plus a note when a newer version exists.
5. **"Keep access".** Passkey creation, the existing setup states (`setup`, `replace-offer`, `setup-refused`), then the claim. If more than 15 minutes have passed since sign-in, a new code is asked for.
6. **Done.** `invite-claimed`, then the normal reader under role `invited`. Under D13 this does not list under "Shared with you" until the owner confirms.
7. **Other outcomes.** `invite-expired`, `invite-withdrawn`, `invite-used`, `invite-wrong-address`, `invite-damaged`.

### 5.3 Owner

- **Share section.** Mixed grants and invitations in one tap, then the links to send.
- **Invitations section.** Open, accepted, expired and withdrawn rows, with Cancel, Remove, Invite again, and "Confirm with passkey".
- **Email on claim.**
- **Access log rows:** "Invited", "Key fetched", "Invitation accepted", "Shared directly", "Access revoked".

## 6. Signing integration (D1a)

- **How the composer resolves each signer:**
  - the owner's own address becomes the owner identity;
  - an admitted grant becomes a reader;
  - anything else is looked up on the first click of Send:
    - `party: null` is unregistered, and the invitation note shows if there is one;
    - `standing: 'invited'` and other registered standings are granted, with the fingerprint shown first;
    - an unverified `grantee` shows "Reload and try again."
- **The tap:**
  1. attest `signing_request`;
  2. sign the grant drafts with `tapped.identity`, with `versions: [version]`;
  3. fetch the version key once;
  4. wrap it to each new signer;
  5. post C.
- **Order on the server.** Preflight runs before any grant. Standing is checked after the grants apply. The standing rules are unchanged: a live grant plus a wrap, and the owner is exempt.
- **If the request fails after the grants applied,** the grants stay and are listed in `granted`.
- **Email follows D5.**

## 7. relic-mcp

It cannot create grants or invitations (3.4). It composes `grant_url` locally, and never sends it or sees a key (3.9). Installed versions are unaffected, because invitations and claims stay out of `/recipients`.

## 8. Slices

**Dependencies:** C0 comes first. S0 comes before S2. S1, S2, S3 and S5 run in parallel. S4 runs after S1, S2 and S3 are integrated. One writer per file.

**C0. Format contract** (`relic-format/src/{private,private-wire,share}.ts`, the index, tests; `relic-viewer/src/private/access-log.ts` labels only)

- **Change:** section 3.1.
- **Acceptance:**
  - known-answer bytes for `invite` and `invite_claim`;
  - strict refusal of extra or missing fields;
  - a key pair from `generateInviteKeyPair` round-trips a `wrapVersionKey` through `inviteRecipient`;
  - `parseInviteFragment` refuses anything that is not `k=` plus 43 characters;
  - the typecheck is green.

**S0. Mock** (`docs/plans/direct-share/mockup.html`, committed with this plan)

- **Change:** a self-contained, clickable mock with the copy from 3.6 and 3.8. It shows:
  - every direct-share state;
  - a Share section with mixed grant and invite rows and the lifetime picker;
  - the links shown after the tap;
  - the Invitations section in every state, including Confirm;
  - every invitee state from 5.2;
  - both notice emails and the owner-composed email;
  - log rows;
  - the prefilled `grant_url` landing.
- **Acceptance:** works offline in isolated headless Chrome; every state can be reached; the brand guard and dash check pass.

**S1. Server** (`relic-server/src/private/{relic,attest,identity,access,context}.ts`, `signing.ts`, `app.ts`, `store.ts`, `gcsstore.ts`, `ratelimit.ts`, `config.ts`, `problems.ts`, `mail.ts`; `deploy/terraform/modules/relic/resource.google_storage_bucket.relics.tf` prefixes; tests: a new `private-direct-share.test.ts`, a new `private-invites.test.ts`, and additions to `gcsstore.test.ts`, `private-routes`, `private-lifecycle`, `signing-requests` and `private-mail`)

- **Change:** routes A to J; the shared `applyGrants` core; `applyInvites`; claim; standing and roles; the sweeps from 4.3; email; log; configuration; the limiter.
- **Non-goals:**
  - any change to `/recipients`, seals, certificates or `grant` statements;
  - any budget backed by the store;
  - coverage repair.
- **Acceptance,** observed against `createApp` with `MemoryStore`, the fake authenticator and fake GCS:
  - the direct-share observables from the earlier version;
  - a mixed batch of 1 grant and 2 invitations in one tap returns 201, with two rows whose wraps open under their invite keys;
  - G, H and I return the uniform 404 or 403 for a different address and for a bogus id;
  - J commits claimant wraps and the signed claim inside the invitation row, gives role `invited`, and empties its temporary wraps;
  - a same-identity repeat returns 201 without changing the winner, a different identity is refused, and a cancel that wins returns `410 invite_revoked`;
  - an unclaimed expired invitation is refused by G, H, I and J;
  - under fake GCS: an unclaimed invite row's `customTime` follows invitation expiry, a claimed row and its index follow relik expiry, and lifetime extension and deletion follow 4.3;
  - open and claimed invitations do not change `/recipients`; confirming one adds the ordinary grant;
  - an invitation to a registered address returns 409 and still charges the lookup budget.

**S2. Viewer** (`private/{owner-panel,reader,fingerprint-input,open}.ts`, a new `private/direct-share.ts`, a new `private/invite.ts`, `signing/{composer,controller,api}.ts`; tests)

- **Change:** the direct-share flow; mixed taps with invite key generation; the links panel; the Invitations section; invite mode in the reader; the temporary reader view (a `ReadyView` with an invite `keyFor` and the collaboration surfaces hidden, `reader.ts:686-757`); setup then claim; composer annotations; `problemMessage` for the new codes.
- **Non-goals:** request-card behaviour, the dashboard, persisting any invite key.
- **Acceptance,** in happy-dom against recorded answers:
  - one tap carries N mixed drafts;
  - wraps cover the union, with one key fetch per version;
  - after mount `location.hash` is empty, and no request body contains `d`;
  - invite mode drives each state in 5.2 from G's answers;
  - the claim body signs `invite_claim` and re-wraps to the identity's KEM key;
  - collaboration surfaces are absent in `invite-ready`.

**S3. relic-mcp** (`src/{share,signing,server}.ts`, the version, tests)

- **Change:** section 3.9.
- **Acceptance:** `grant_url` with zero fetches; the refusal carries `grant_url`; descriptions pass the brand guard.

**S4. Proof** (`relic-mcp/test/direct-share-path.ts`; only the export list of `private-shares-steps.ts`; a `verify.yml` step after "Signing path"; `PATH.md`; an operator-run stage in `private-shares-live-probe.ts`)

- **Change:** the harness reuses `signing-path.ts:64-192`. A clock the harness controls is injected through `createApp` `now`.
- **Acceptance:** section 10.

**S5. Docs.** Section 13.

## 9. Review risks for each slice

Independent review is required for S1 and S2 (security boundaries). The others get a bounded review.

- **S1.** Each risk, with the evidence that resolves it:

  | Risk | Evidence |
  |---|---|
  | Each served `GrantJSON` verifies for its own grantee | the per-grantee verification test |
  | No check before the read depends on registration | identical refusals for registered and unregistered inputs |
  | Invitation creation is charged before `identity_exists` | the budget test |
  | Every invite read path compares addresses and answers uniformly | the different-address and bogus-id tests |
  | Temporary and claimant wraps never enter `m/wrap/` | store assertions |
  | Open and claimed invitations do not change `/recipients`; confirmation adds an ordinary grant | the deep-equal test and confirmation path |
  | Claim CAS records the claim and wraps atomically | same-identity repeat and cancel race tests |
  | Claimed invite rows and indexes are extended, unclaimed invite rows are not | fake-GCS tests |
  | Both delete sweeps cover invites and claims | delete tests |
  | Terraform carries the prefixes | the validate step plus a test that diffs the prefix list against the store families |
  | `privateReach` admits `invited` only by decision | a test |
  | The signing allow-list still excludes `invited` | a test |

  Out of scope: `privateBody` reads unbounded JSON before auth (`app.ts:840-862`).
- **S2.** The invite key never leaves memory: assert `fetch` bodies and the absence of `localStorage` writes. Only verified keys are wrapped. The fragment is stripped before the first request.
- **S3.** No fetch, and no key in output.
- **S4.** Every receipt is backed by an assertion; the mutation controls fail as expected.
- **Coverage:** partial grants no longer produce gaps on versions outside their coverage; a missing covered wrap still produces a gap.

## 10. End-to-end proof (`direct-share-path.ts`)

The receipts print in order, then `DIRECT_SHARE_PATH_OK` with exit code 0. A defect prints `DEFECT <id>: ...` and `DIRECT_SHARE_PATH_BLOCKED`, with exit code 1. Every write goes to loopback.

**Direct share:**

1. `DIRECT_STEP_1_LOOKUP_GATE signed_out=401 other_reader=403 public_relik=400 owner=200 fingerprint_field=absent unregistered=null standing_self=owner`
2. `DIRECT_STEP_2_BUDGET per_address=true shared_with_recovery=true ip_budget=429 non_owner_charged=false`
3. `DIRECT_STEP_3_PANEL fingerprints=local_match self=that_is_you reader=already prefill=fragment fragment_after_open=absent`
4. `DIRECT_STEP_4_ONE_TAP owner_sign_count_delta=1 grants=2 statements_verify=owner_key stored_grant=reverifies wraps=exact v1_wraps=0 log=share,share`
5. `DIRECT_STEP_5_NOTICE per_recipient=1 names_owner=true fingerprint=own title=absent file=absent fragment=absent other_recipient=absent`
6. `DIRECT_STEP_6_RECIPIENT_OPENS states=signin,unlock,ready request_state=never v2=opened v1_key=403 shared_with_you=listed`
7. `DIRECT_STEP_7_LATER_VERSION mcp_republish=sealed mcp_roster=accepts_batch_grants recipient_v3=opened`
8. `DIRECT_STEP_8_REPEAT_AND_REVOKED repeat_api=409_grant_exists wraps_unchanged=true revoked_regrant=201 revoked_reader_opens=current`
9. `DIRECT_STEP_9_REFUSALS self=400_grantee wrong_fingerprint=409 substituted_lookup=ui_shows_substitute substituted_api=400_grantee substitute_wraps=0 retired_identity=400_grantee`
10. `DIRECT_STEP_10_REQUEST_PATH lookup_standing=requested grant_log=grant grant_mail=unchanged`
11. `DIRECT_STEP_11_SIGNING_ONE_TAP owner_sign_count_delta=1 new_signer_versions=[n] owner_as_signer=accepted request=open signer_mails=1:invite signed=ok certificate=valid`
12. `DIRECT_STEP_12_SIGNING_REFUSALS unregistered_signer=send_disabled grants_on_device_path=400 grantee_not_signer=400 versions_not_request=400`
13. `DIRECT_STEP_13_MCP share_grant_url=fragment_addresses service_calls=0 key_in_output=false request_signatures=recipient_forged_grant grant_url_in_refusal=true`

**Invitations:**

14. `INVITE_STEP_1_CREATE batch=grant:1,invite:2 owner_sign_count_delta=1 invite_rows=2 wraps_open_under_invite_key=true d_in_any_request=false notice_mails=2 notice_names_owner=true notice_link=absent notice_key=absent links_shown=2`
15. `INVITE_STEP_2_ADDRESS_BOUND signed_out=401 other_address=404 bogus_id=404 same_body=true key_other=403 mint_other=403`
16. `INVITE_STEP_3_OPEN_WITH_CODE sign_in=code state=invite-ready listed=opened unlisted_key=403 comments=absent signing=absent fragment_after_open=absent log=wrap_fetch:address receipts=0 key_in_body=absent`
17. `INVITE_STEP_4_CLAIM passkey_created=1 identity=registered extra_claim_taps=0 claim_wraps=listed claim_store=invite_row m_wrap=absent invite_wraps=0 role=invited reads_after_invite_expiry=ok log=claim owner_mail=1`
18. `INVITE_STEP_5_SINGLE_USE second_tab=201_same_claimant_repeat winner_wraps_intact=true reopen_same_identity=reader`
19. `INVITE_STEP_6_INVISIBLE recipients_equal_without_invites=true mcp_republish=sealed new_version_wrapped_to_claimant=false`
20. `INVITE_STEP_7_CONFIRM owner_sign_count_delta=1 grant=live claim=retained invitation=confirmed mcp_republish_after=wraps_claimant claimant_opens_new_version=ok`
21. `INVITE_STEP_8_EXPIRY open_status=expired key=403 mint=403 claim=410_invite_expired`
22. `INVITE_STEP_9_REVOKE cancel_open=wraps_0 link_state=invite-withdrawn remove_claimed=claim_wraps_0 key=403 role=revoked`
23. `INVITE_STEP_10_REKEY revoke_other=new_version open_invite_listed=ok open_invite_new_version=403`
24. `INVITE_STEP_11_REGISTERED invite_for_registered=409_identity_exists lookup_charged=true existing_identity=unlock_then_claim already_reader=consumed_no_extra_wraps_or_index`
25. `INVITE_STEP_12_DELETE version_delete=versions_stripped surviving_key=200 deleted_key=403`, followed by `INVITE_STEP_12_RELIK_DELETE whole_relik=invites_0,claim_indexes_0 checked_claimants=3`.
26. `INVITE_STEP_13_MCP grant_url_unregistered=invite_offered mcp_invite_tool=absent`

**Mutation controls,** recorded in `PATH.md`. Each must fail its step:

| Mutation | Step that must fail |
|---|---|
| owner check removed from the lookup | 1 |
| budget charged per call | 2 |
| `grantJson` serves `statements[0]` | 7 |
| fingerprint check skipped | 9 |
| version filter dropped | 6 |
| signer membership skipped | 12 |
| address check removed from G | 15 |
| invitation compare-and-swap skipped | 18 |
| claim stops emptying the invitation's wraps | 17 |
| lookup charge for invitations skipped | 24 |
| claimed invite rows excluded from `extendPrivateLifetime` | the S1 fake-GCS test |

**After deploy (operator run, not CI):**

- `DIRECT_LIVE share=201 notice=received open=ok deleted=ok`
- `INVITE_LIVE create=201 code_open=ok claim=201 confirm=201 deleted=ok`

Both use `+tag` addresses and finish with a hard delete. Until they run, production is proven only on loopback (`decisions.md:1212`).

## 11. Checklist for the independent security review

| Item | What must hold, and the evidence that passes it |
|---|---|
| Registration oracle | Lookups and invitation creation share the per-identity and per-IP budgets, charged before any check that depends on registration. Non-owners are refused first. No log line carries an address. Evidence: steps 2 and 24, plus a grep of new `console.*` calls. |
| Owner checks use the current identity | Every owner route goes through `ownedPrivate`. Evidence: a test with a retired owner. |
| Substituted keys | `verifiedPartyKeys`; the service's grantee-email and fingerprint checks. Evidence: step 9. |
| Correct wraps | Exact sets of `(version, recipient)` pairs; the browser wraps only verified keys; the invitee verifies the owner-signed invitation and runs the seal and commitment checks before using any key. Evidence: steps 4, 6, 14 and 16. |
| The invitation is bound to the address | G, H, I and J compare the session address. Other addresses and bogus ids get the same answer. Evidence: step 15. |
| The invite key never reaches the service | Only the fragment carries it. It is stripped at mount, appears in no body, log or email, and is never stored. Evidence: steps 14 and 16 and the S2 assertions. |
| Replay and races | Single-use nonces; fresh statements; an invitation compare-and-swap that commits claim wraps; nonce-guarded grant-row rollback. A crossed owner deletion cleans this grant's pairs for deleted versions or a removed relik. Evidence: steps 18 and 8 and the server race tests. |
| Installed clients | `/recipients` is unchanged by invitations and claims. Evidence: step 19. |
| Only the owner grants later versions | A claim never adds anyone to R. Confirmation is an owner-signed `grant`. Evidence: steps 19 and 20. |
| Role surfaces | `invited` can read, comment and decide by decision, and is not a signer. Evidence: S1 tests. |
| Revocation, expiry, version deletion | Direct cancellation and version deletion remove the specified wraps; grant revocation commits the cutoff before best-effort cleanup. Evidence: steps 21, 22 and 25 and the server race tests. |
| Lifecycle | Unclaimed invite `customTime` equals invitation expiry; claimed rows and indexes follow relik expiry; prefixes are in Terraform; both delete sweeps cover invitations and indexes. Evidence: S1 fake-GCS tests and the validate step. |
| Email | Content as in 3.6, and gating as in 3.6. Evidence: steps 5, 14 and 17. |
| Recovery | Claim wraps are embedded in invitation rows and are not touched by `m/wrap/` sweeps. Evidence: the server tests. |
| Self, retired, signing-route grants | As before. Evidence: steps 9 and 12. |

## 12. Residuals to disclose

1. **The fingerprints the owner sees come from the service that holds the keys.** The direct-share email's fingerprint is written by that same service.
2. **Any identity holder can test whether an address has a key.** Owners can also see standing. All of it shares one budget.
3. **Email to registered addresses is bounded only by budget.** Direct-share email and invitation notices reach any address an owner names, within that owner's budget, with no opt-out per recipient. Notices name the owner.
4. **Budgets are per instance.**
5. **Grants made in the signing composer are committed by the request's tap,** not by a tap over the grant itself.
6. **A signing request can fail after its grants applied.** The grants stay.
7. **Re-sharing with a revoked reader replaces the grant record.**
8. **An existing reader cannot be given earlier versions** without being revoked first.
9. **The `grant_url` addresses appear in the agent's transcript** and briefly in the address bar.
10. **Access email bypasses the notifications setting and the stop list.**
11. **Until an invitation is claimed, anyone who holds both the link and the invited mailbox can read the listed versions,** and can also claim them for an identity they register.
12. **The service can read neither the invite key nor the file.** It does learn the invited address, the versions, the expiry and each key fetch. The owner's mailbox and mail provider see each link.
13. **Erasure of an expired invitation is not instant.** Expiry refuses access immediately. The lifecycle erases the row and its wraps one day later, and soft-delete retention keeps a recoverable copy after that.
14. **A claim outlives the invitation** until the owner revokes that address's access. It gives the invitee access to the listed versions, and keys they have already opened cannot be recalled.
15. **Until the owner confirms,** a claimed invitation is absent from "Shared with you" and receives no later versions.
16. **A lost link cannot be shown again.** The owner cancels and invites again.
17. **Reloading the invitation page loses the key.** The invitee reopens the link from the email.
18. **Revocation crash windows.** A crash after marking the grant and before committing the fence leaves the grant revoked and older invitations unfenced. A later regrant commits a fence that keeps those older claims from reviving. A crash after the revocation commit and before the wrap sweep leaves ordinary wraps in storage; they serve nothing under the revoked grant until regrant, version deletion or relik deletion.
19. **Lost grant commit response.** The grant rollback runs even if the epoch commit landed, so rows owned by the call are removed or restored and created invitation rows are removed. This fails closed.

## 13. Documentation changes (S5)

- **`decisions.md`:** two entries.
  - "Direct shares": as in the earlier version.
  - "Invitations for an address with no key": the four owner decisions, D12 to D21, correction 11 as the reason for model B, the costs from residuals 11 to 17, and the reversal that the owner always sends key-bearing links.
- **`frame.md:143` and `:162`:** a private relik opens for an identity the owner granted with a passkey (from a request, or directly by address), or temporarily for an address the owner invited, proven with a sign-in code. Agents can neither approve, grant nor invite. Add residuals 2, 3, 11 and 12 to the costs.
- **`service.md`:** routes A to J; the new codes in 1.17; batches, invitations and claims in 10.4; the new kinds in 10.6; the configuration in 10.7; residuals in 10.9; grants in 12.
- **`docs/design/storage.md`:** both new families, the `customTime` rules, the prefix list at `:322`, and the sweeps in 4.3.
- **`format.md`:**
  - 3.17: rows for `invite` and `invite_claim`; `grant` is attested "by its own tap, or by the signing-request tap that names the grantee";
  - `:440`: stored grants are re-verified with `verifyStoredGrant`;
  - `:487`: fix as in correction 9;
  - a new "Invitation links" subsection covering `?invite=` and `#k=`, and `inviteRecipient`.
- **`viewer.md`:** in 6.12, the Share and Invitations hooks, the invitee states, `?access=share` and `?access=invites`, and the log kinds; in 6.15, composer grants.
- **`publish.md`:** `relic_share` and `grant_url`; the `recipient_forged_grant` row at `:368`.
- **`PATH.md`:** a "Direct share and invitations" section with the receipts and the mutation controls.

## 14. What would prove this spec wrong

- Something other than tests reads the WebAuthn evidence on grant rows. Today only signature retries call `verifyStoredAttestation` (`signing.ts:1098`).
- The signing body exceeds 65,536 bytes at the maximum sizes.
- `rosterGrants` or relic-mcp `verifyGrant` rejects a grant from a batch or from the signing route (steps 7, 11 and 20).
- `/recipients` changes when a relik has invitations or claims (step 19).
- A target browser's WebCrypto refuses to import an ECDH JWK with `d`. The invite key would then need the PKCS#8 form, which changes `inviteFragment`, not the design.
- The owner picks D13 (C): drop J, the claim row and the `invited` role; access ends at expiry.
- The owner picks D16 (b): F runs for every open invitation inside `revokeAccess`.