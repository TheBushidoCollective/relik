/**
 * Asking the owner for access, and reading where a reader stands on a private
 * relic. A request is one passkey tap: `attest` unlocks the identity inside
 * that tap and signs the access request with it.
 */

import type { AccessRole } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import {
  nowMs,
  postJson,
  readField,
  requestFailure,
  type UnlockedIdentity,
} from './keys.ts';
import { privateKeysOf } from './ops.ts';

/** Where the signed-in reader stands on one relic, from the service's view. */
export interface AccessView {
  readonly role: AccessRole;
  readonly ownerEmail: string | null;
  readonly expiresAt: string;
  readonly currentVersion: number;
  readonly sealedVersion: number | null;
  readonly readableVersions: readonly number[];
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') throw new TypeError('version');
  return value;
}

function accessRole(value: unknown): AccessRole {
  switch (value) {
    case 'owner':
    case 'grantee':
    case 'recovery':
    case 'revoked':
    case 'requested':
    case 'declined':
    case 'none':
      return value;
    default:
      throw new TypeError('access role');
  }
}

/** The reader's access on a private relic, read as the service reports it. */
export async function loadAccess(
  deps: ViewerDeps,
  relicId: string
): Promise<AccessView> {
  const response = await deps.fetch(
    `${deps.serviceOrigin}/api/relics/${encodeURIComponent(relicId)}/access`
  );
  if (!response.ok) throw await requestFailure(response);
  const body: unknown = await response.json();
  const owner = readField(body, 'owner');
  const ownerEmail = readField(owner, 'email');
  const readable = readField(readField(body, 'me'), 'readable_versions');
  const expiresAt = readField(body, 'expires_at');
  const currentVersion = readField(body, 'current_version');
  if (
    !Array.isArray(readable) ||
    typeof expiresAt !== 'string' ||
    typeof currentVersion !== 'number'
  ) {
    throw new TypeError('access response');
  }
  return {
    role: accessRole(readField(readField(body, 'me'), 'role')),
    ownerEmail: typeof ownerEmail === 'string' ? ownerEmail : null,
    expiresAt,
    currentVersion,
    sealedVersion: nullableNumber(readField(body, 'sealed_version')),
    readableVersions: readable.filter(
      (version): version is number => typeof version === 'number'
    ),
  };
}

/**
 * Sends the access request, one tap. Returns the identity that signed it, so
 * the caller can show that identity's fingerprint without asking again.
 */
export async function requestAccess(
  deps: ViewerDeps,
  relicId: string
): Promise<UnlockedIdentity> {
  const { identity, bundle } = await privateKeysOf(deps).attest(deps, {
    purpose: 'access_request',
    relicId,
    build: (identityId) => [
      {
        kind: 'access_request',
        statement: {
          at: nowMs(deps),
          relic_id: relicId,
          requester_identity_id: identityId,
        },
      },
    ],
  });
  await postJson(deps, `/api/relics/${encodeURIComponent(relicId)}/requests`, {
    attestation: bundle,
  });
  return identity;
}
