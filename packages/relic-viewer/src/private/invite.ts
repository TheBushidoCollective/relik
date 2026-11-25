import {
  decodeBase64url,
  inviteIdOf,
  inviteRecipient,
  parseStatement,
  signStatement,
  statementBytes,
  verifyStatement,
  wrapVersionKey,
  type HpkeRecipient,
  type InviteOpenJSON,
  type WrapJSON,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { claimInvite, openInvite } from './invite-wire.ts';
import { nowMs, type UnlockedIdentity } from './keys.ts';
import {
  fetchAndDecryptVersion,
  pinnedOwnerFor,
  SealMismatchError,
  verifyVersionKey,
} from './open.ts';
import { verifiedPartyKeys } from './rekey.ts';

export interface VerifiedInvitation {
  readonly open: InviteOpenJSON;
  readonly recipient: HpkeRecipient;
}

/** Read an address-bound invitation and verify the owner's signed scope. */
export async function openInvitation(
  deps: ViewerDeps,
  relicId: string,
  inviteId: string,
  d: Uint8Array
): Promise<VerifiedInvitation> {
  const open = await openInvite(deps, relicId, inviteId);
  const keys = await verifiedPartyKeys(open.owner);
  const statement = parseStatement('invite', open.invite.statement);
  const publicKey = decodeBase64url(statement.invite_public_key);
  const pin = pinnedOwnerFor(relicId);
  if (
    open.relic_id !== relicId ||
    open.invite_id !== inviteId ||
    statement.relic_id !== relicId ||
    statement.owner_identity_id !== open.owner.identity.identity_id ||
    (await inviteIdOf(publicKey)) !== inviteId ||
    (pin !== undefined && pin.identityId !== statement.owner_identity_id) ||
    JSON.stringify(open.versions) !== JSON.stringify(statement.versions) ||
    !(await verifyStatement(
      keys.sigPublicKey,
      statementBytes('invite', statement),
      open.invite.identity_signature
    ))
  ) {
    throw new SealMismatchError('invitation');
  }
  return { open, recipient: await inviteRecipient(d, publicKey) };
}

function inviteContext(invitation: VerifiedInvitation) {
  return {
    inviteId: invitation.open.invite_id,
    recipient: invitation.recipient,
    ownerId: invitation.open.owner.identity.identity_id,
  };
}

/** The temporary identity only supplies the HPKE recipient; it signs nothing. */
const unusedIdentity = {} as UnlockedIdentity;

export async function inviteVersionKey(
  deps: ViewerDeps,
  invitation: VerifiedInvitation,
  version: number
): Promise<Uint8Array> {
  if (!invitation.open.versions.includes(version))
    throw new SealMismatchError('invitation_version');
  return (
    await verifyVersionKey(
      deps,
      invitation.open.relic_id,
      version,
      unusedIdentity,
      inviteContext(invitation)
    )
  ).key;
}

export async function openInvitedVersion(
  deps: ViewerDeps,
  invitation: VerifiedInvitation,
  version: number
) {
  if (!invitation.open.versions.includes(version))
    throw new SealMismatchError('invitation_version');
  return fetchAndDecryptVersion(
    deps,
    invitation.open.relic_id,
    version,
    unusedIdentity,
    inviteContext(invitation)
  );
}

/** Move verified listed version keys to the claimant's identity, without another tap. */
export async function claimInvitation(
  deps: ViewerDeps,
  invitation: VerifiedInvitation,
  identity: UnlockedIdentity
): Promise<void> {
  const { open } = invitation;
  const wraps: WrapJSON[] = [];
  for (const version of open.versions) {
    const key = await inviteVersionKey(deps, invitation, version);
    const wrap = await wrapVersionKey({
      recipientPublicKey: identity.kemPublicKey,
      relicId: open.relic_id,
      version,
      key,
    });
    wraps.push({
      recipient_key_id: wrap.recipientKeyId,
      version,
      enc: wrap.enc,
      ct: wrap.ct,
    });
  }
  const statement = {
    at: nowMs(deps),
    claimant_identity_id: identity.identityId,
    invite_id: open.invite_id,
    relic_id: open.relic_id,
    versions: open.versions,
  };
  const identity_signature = await signStatement(
    (bytes) => identity.sign(bytes),
    statementBytes('invite_claim', statement)
  );
  await claimInvite(deps, open.relic_id, open.invite_id, {
    statement,
    identity_signature,
    wraps,
  });
}
