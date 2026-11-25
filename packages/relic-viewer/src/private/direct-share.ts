/**
 * The owner's side of direct share and invitations: the lookup for the Share
 * section, the one-tap batch that grants registered addresses and invites the
 * rest, the invitation list, and the prefilled addresses of `?access=share`.
 *
 * An invitation's private key is generated here, wrapped into the grant
 * request's wraps, and returned as a link. It is never stored: the caller keeps
 * the link only until the owner has sent it.
 */

import { normalizeEmail } from '@relic/format';
import {
  encodeBase64url,
  generateInviteKeyPair,
  type GrantLookupJSON,
  type GrantLookupResultJSON,
  identityFingerprint,
  type InviteJSON,
  inviteFragment,
  inviteIdOf,
  type PartyJSON,
  type WrapJSON,
  wrapVersionKey,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { privateApi } from './fingerprint-input.ts';
import { nowMs } from './keys.ts';
import { privateKeysOf } from './ops.ts';
import { VerificationRefusedError } from './refusal.ts';
import { verifiedPartyKeys } from './rekey.ts';

/** What the Share section shows for one typed address. */
export type ShareRow =
  | { readonly kind: 'reader'; readonly email: string }
  | { readonly kind: 'self'; readonly email: string }
  | { readonly kind: 'unverified'; readonly email: string }
  | {
      readonly kind: 'unregistered';
      readonly email: string;
      readonly invites: GrantLookupResultJSON['invites'];
    }
  | {
      readonly kind: 'registered' | 'invited';
      readonly email: string;
      readonly party: PartyJSON;
      readonly fingerprint: string;
    };

/** A registered person the batch grants. */
export interface GrantTarget {
  readonly party: PartyJSON;
  readonly fingerprint: string;
}

/** An address with no key yet, invited for `days` days. */
export interface InviteTarget {
  readonly email: string;
  readonly days: number;
}

/** A link to send. It holds the invitation's private key, so it lives only in the page. */
export interface InviteLink {
  readonly inviteId: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly versions: readonly number[];
  readonly url: string;
}

export const INVITE_DAYS_MIN = 1;
export const INVITE_DAYS_MAX = 30;
export const INVITE_DAYS_DEFAULT = 7;
/** The most addresses one `?access=share` link prefills (the per-call maximum). */
export const SHARE_PREFILL_MAX = 20;

const DAY_MS = 86_400_000;

/** One address's fingerprint, computed here from the identity the service returned. */
export async function grantTargetFor(party: PartyJSON): Promise<GrantTarget> {
  return {
    party,
    fingerprint: await identityFingerprint(
      party.identity.identity_id,
      party.email
    ),
  };
}

/**
 * Looks up typed addresses for the owner. A registered party is verified and
 * fingerprinted here; a party whose keys do not verify is shown as unverified,
 * and is never granted.
 */
export async function lookupShares(
  deps: ViewerDeps,
  relicId: string,
  emails: readonly string[],
  admitted: ReadonlySet<string>
): Promise<ShareRow[]> {
  const result = await privateApi<GrantLookupJSON>(
    deps,
    'POST',
    `/api/relics/${encodeURIComponent(relicId)}/grants/lookup`,
    { emails }
  );
  if (
    !Array.isArray(result.results) ||
    result.results.length !== emails.length
  ) {
    throw new Error('invalid lookup response');
  }
  return Promise.all(
    result.results.map(async (entry, index): Promise<ShareRow> => {
      const email = emails[index];
      if (
        email === undefined ||
        normalizeEmail(entry.email) !== normalizeEmail(email)
      ) {
        throw new Error('invalid lookup response');
      }
      if (entry.standing === 'owner') return { kind: 'self', email };
      if (entry.party === null) {
        return { kind: 'unregistered', email, invites: entry.invites };
      }
      try {
        if (normalizeEmail(entry.party.email) !== normalizeEmail(email)) {
          throw new Error('party address mismatch');
        }
        await verifiedPartyKeys(entry.party);
        const target = await grantTargetFor(entry.party);
        if (entry.standing === 'grantee') {
          return { kind: admitted.has(entry.party.identity.identity_id) ? 'reader' : 'unverified', email };
        }
        return {
          kind: entry.standing === 'invited' ? 'invited' : 'registered',
          email,
          party: entry.party,
          fingerprint: target.fingerprint,
        };
      } catch {
        return { kind: 'unverified', email };
      }
    })
  );
}

/** The expiry an invitation made now gets: `days` from now, never past the relik's own expiry. */
export function inviteExpiresAt(
  now: number,
  days: number,
  relicExpiresAt: number
): number {
  return Math.min(now + days * DAY_MS, relicExpiresAt);
}

export interface ShareBatch {
  readonly relicId: string;
  /** The versions every grant and invitation in the batch covers. */
  readonly versions: readonly number[];
  readonly relicExpiresAt: number;
  readonly grants: readonly GrantTarget[];
  readonly invites: readonly InviteTarget[];
  /** The page origin the invitation links are built on. */
  readonly origin: string;
}

/**
 * The one-tap share: every grant and every invitation in one attestation,
 * under the `grant` purpose. The key of each invitation is generated before the
 * tap, wrapped to every listed version, and returned in the link. No invitation
 * key reaches the request body or any store.
 */
export async function shareBatch(
  deps: ViewerDeps,
  batch: ShareBatch
): Promise<InviteLink[]> {
  if (batch.grants.length === 0 && batch.invites.length === 0) return [];
  if (batch.versions.length === 0) throw new Error('no versions');
  const now = nowMs(deps);
  if (
    batch.grants.length + batch.invites.length > SHARE_PREFILL_MAX ||
    !Number.isFinite(batch.relicExpiresAt) ||
    batch.relicExpiresAt <= now ||
    batch.invites.some(({ days }) => !Number.isInteger(days) || days < INVITE_DAYS_MIN || days > INVITE_DAYS_MAX)
  ) throw new Error('invalid share batch');
  const versions = [...batch.versions].sort((a, b) => a - b);
  const grantees = await Promise.all(
    batch.grants.map(async (grant) => {
      const keys = await verifiedPartyKeys(grant.party);
      if (grant.fingerprint !== await identityFingerprint(grant.party.identity.identity_id, grant.party.email)) {
        throw new VerificationRefusedError('The fingerprint changed. Nothing was sent.');
      }
      return { grant, keys };
    })
  );
  const invitations = await Promise.all(
    batch.invites.map(async (invite) => {
      const pair = await generateInviteKeyPair();
      return {
        invite,
        pair,
        inviteId: await inviteIdOf(pair.publicKey),
        expiresAt: inviteExpiresAt(
          now,
          invite.days,
          batch.relicExpiresAt
        ),
      };
    })
  );

  const tapped = await privateKeysOf(deps).attest(deps, {
    purpose: 'grant',
    relicId: batch.relicId,
    build: (owner) => [
      ...batch.grants.map((grant) => ({
        kind: 'grant' as const,
        statement: {
          at: now,
          fingerprint_typed: grant.fingerprint,
          grantee_email: grant.party.email,
          grantee_identity_id: grant.party.identity.identity_id,
          owner_identity_id: owner,
          relic_id: batch.relicId,
          versions,
        },
      })),
      ...invitations.map((item) => ({
        kind: 'invite' as const,
        statement: {
          at: now,
          expires_at: item.expiresAt,
          invite_public_key: encodeBase64url(item.pair.publicKey),
          invited_email: normalizeEmail(item.invite.email),
          owner_identity_id: owner,
          relic_id: batch.relicId,
          versions,
        },
      })),
    ],
  });

  const wraps: WrapJSON[] = [];
  for (const version of versions) {
    const fetched = await privateKeysOf(deps).fetchVersionKey(
      deps,
      batch.relicId,
      version,
      tapped.identity
    );
    if (
      fetched.keyJson.owner.identity.identity_id !==
      tapped.identity.identityId
    ) {
      throw new VerificationRefusedError(
        'A version of this relik belongs to another owner, so nothing was shared. Nothing was sent.'
      );
    }
    for (const { keys } of grantees) {
      const wrap = await wrapVersionKey({
        recipientPublicKey: keys.kemPublicKey,
        relicId: batch.relicId,
        version,
        key: fetched.key,
      });
      wraps.push({
        recipient_key_id: wrap.recipientKeyId,
        version,
        enc: wrap.enc,
        ct: wrap.ct,
      });
    }
    for (const item of invitations) {
      const wrap = await wrapVersionKey({
        recipientPublicKey: item.pair.publicKey,
        relicId: batch.relicId,
        version,
        key: fetched.key,
      });
      wraps.push({
        recipient_key_id: wrap.recipientKeyId,
        version,
        enc: wrap.enc,
        ct: wrap.ct,
      });
    }
  }

  await privateApi(
    deps,
    'POST',
    `/api/relics/${encodeURIComponent(batch.relicId)}/grants`,
    { attestation: tapped.bundle, wraps }
  );

  return invitations.map((item) => ({
    inviteId: item.inviteId,
    email: item.invite.email,
    expiresAt: item.expiresAt,
    versions,
    url: `${batch.origin}/${encodeURIComponent(batch.relicId)}?invite=${item.inviteId}#${inviteFragment(item.pair.d)}`,
  }));
}

/**
 * The addresses a `?access=share#to=` fragment names, decoded once, split on
 * commas, trimmed, deduplicated and capped. Anything else yields no addresses.
 */
export function parseShareFragment(hash: string): string[] {
  if (!hash.startsWith('#to=')) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash.slice(4));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const part of decoded.split(',')) {
    const address = part.trim();
    if (address === '' || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(address);
    if (addresses.length === SHARE_PREFILL_MAX) break;
  }
  return addresses;
}
