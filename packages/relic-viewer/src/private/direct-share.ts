import { normalizeEmail } from '@relic/format';
import {
  type GrantLookupJSON,
  type GrantLookupResultJSON,
  identityFingerprint,
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

export type ShareRow =
  | { readonly kind: 'reader' | 'self' | 'unverified'; readonly email: string }
  | { readonly kind: 'unregistered'; readonly email: string; readonly invites: GrantLookupResultJSON['invites'] }
  | { readonly kind: 'registered' | 'invited'; readonly email: string; readonly party: PartyJSON; readonly fingerprint: string };

export async function lookupShares(deps: ViewerDeps, relicId: string, emails: readonly string[], admitted: ReadonlySet<string>): Promise<ShareRow[]> {
  const result = await privateApi<GrantLookupJSON>(deps, 'POST', `/api/relics/${encodeURIComponent(relicId)}/grants/lookup`, { emails });
  if (!Array.isArray(result.results) || result.results.length !== emails.length) throw new Error('invalid lookup response');
  return Promise.all(result.results.map(async (entry, index): Promise<ShareRow> => {
    const email = emails[index];
    if (email === undefined || normalizeEmail(entry.email) !== normalizeEmail(email)) throw new Error('invalid lookup response');
    if (entry.standing === 'owner') return { kind: 'self', email };
    if (entry.party === null) return { kind: 'unregistered', email, invites: entry.invites };
    try {
      if (normalizeEmail(entry.party.email) !== normalizeEmail(email)) throw new Error('party address mismatch');
      await verifiedPartyKeys(entry.party);
      const fingerprint = await identityFingerprint(entry.party.identity.identity_id, entry.party.email);
      if (entry.standing === 'grantee') return { kind: admitted.has(entry.party.identity.identity_id) ? 'reader' : 'unverified', email };
      return { kind: entry.standing === 'invited' ? 'invited' : 'registered', email, party: entry.party, fingerprint };
    } catch {
      return { kind: 'unverified', email };
    }
  }));
}

export async function shareRegistered(deps: ViewerDeps, relicId: string, rows: readonly Extract<ShareRow, {kind: 'registered' | 'invited'}>[], versions: readonly number[]): Promise<void> {
  const recipients = await Promise.all(rows.map(async (row) => ({ row, keys: await verifiedPartyKeys(row.party) })));
  const at = nowMs(deps);
  const tapped = await privateKeysOf(deps).attest(deps, {
    purpose: 'grant', relicId,
    build: (owner) => recipients.map(({ row }) => ({ kind: 'grant', statement: {
      at, fingerprint_typed: row.fingerprint, grantee_email: row.party.email,
      grantee_identity_id: row.party.identity.identity_id, owner_identity_id: owner,
      relic_id: relicId, versions,
    } })),
  });
  const wraps: WrapJSON[] = [];
  for (const version of versions) {
    const fetched = await privateKeysOf(deps).fetchVersionKey(deps, relicId, version, tapped.identity);
    if (fetched.keyJson.owner.identity.identity_id !== tapped.identity.identityId) {
      throw new VerificationRefusedError('A version of this relik belongs to another owner. Nothing was sent.');
    }
    for (const recipient of recipients) {
      const wrap = await wrapVersionKey({ recipientPublicKey: recipient.keys.kemPublicKey, relicId, version, key: fetched.key });
      wraps.push({ recipient_key_id: wrap.recipientKeyId, version, enc: wrap.enc, ct: wrap.ct });
    }
  }
  await privateApi(deps, 'POST', `/api/relics/${encodeURIComponent(relicId)}/grants`, { attestation: tapped.bundle, wraps });
}
