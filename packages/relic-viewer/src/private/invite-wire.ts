/**
 * Every invitation route the viewer calls, in one place. Reconciling with the
 * service is a change to this file alone. Each function names the route it
 * posts to and the answer it expects; the callers never build these paths.
 */
import type { InviteJSON, InviteOpenJSON, WrapJSON } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { privateApi } from './fingerprint-input.ts';

function base(relicId: string): string {
  return `/api/relics/${encodeURIComponent(relicId)}`;
}

/** The body that asks for a version's key or a mint as an invitee (route H, I). */
export function inviteKeyBody(inviteId: string): { invite_id: string } {
  return { invite_id: inviteId };
}

/** GET the owner's invitations to one relik (route E). */
export async function listInvites(
  deps: ViewerDeps,
  relicId: string
): Promise<InviteJSON[]> {
  const answer = await privateApi<{ invites: InviteJSON[] }>(
    deps,
    'GET',
    `${base(relicId)}/invites`
  );
  return answer.invites;
}

/** POST the owner's cancel or removal of one invitation (route F). No passkey. */
export async function revokeInvite(
  deps: ViewerDeps,
  relicId: string,
  inviteId: string
): Promise<void> {
  await privateApi(
    deps,
    'POST',
    `${base(relicId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
    {}
  );
}

/** POST the invitee's read of an invitation, for the signed-in address only (route G). */
export async function openInvite(
  deps: ViewerDeps,
  relicId: string,
  inviteId: string
): Promise<InviteOpenJSON> {
  return privateApi<InviteOpenJSON>(
    deps,
    'POST',
    `${base(relicId)}/invites/${encodeURIComponent(inviteId)}/open`,
    {}
  );
}

/** POST the invitee's claim: the signed `invite_claim` and the re-wrapped keys (route J). */
export async function claimInvite(
  deps: ViewerDeps,
  relicId: string,
  inviteId: string,
  claim: {
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
    readonly wraps: readonly WrapJSON[];
  }
): Promise<void> {
  await privateApi(
    deps,
    'POST',
    `${base(relicId)}/invites/${encodeURIComponent(inviteId)}/claim`,
    claim
  );
}

