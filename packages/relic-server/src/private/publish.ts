/**
 * Private publishing (plan 4.7 and 4.13): the regulated profile every private
 * relic gets, and the device's signed authority to create one.
 *
 * A private publish carries no title, no owner address and no share
 * verifier, always expires, and has no cover. Its owner is the identity
 * behind the signing device, so the service learns which owner a grant
 * belongs to from a verified signature, never from the request body.
 */

import {
  decodeBase64url,
  parseStatement,
  statementBytes,
  verifyStatement,
  InvalidStatementError,
} from '@relic/format/private';
import { ProblemError } from '../problems.ts';
import type { IdentityRecord } from '../store.ts';
import { DAY_MS, type PrivateEnv } from './context.ts';

/** Refuses every field the regulated profile forbids (plan 4.13). */
export function refusePrivatePolicy(body: Record<string, unknown>): void {
  const title = body['title'];
  if (typeof title === 'string' && title.trim().length > 0) {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'title',
    });
  }
  if (title !== undefined && title !== null && typeof title !== 'string') {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'title',
    });
  }
  if (body['owner_email'] !== undefined && body['owner_email'] !== null) {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'owner_email',
    });
  }
  if (body['owner'] !== undefined && body['owner'] !== null) {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'owner_email',
    });
  }
  if (body['share_verifier'] !== undefined && body['share_verifier'] !== null) {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'share_verifier',
    });
  }
}

/**
 * Checks a private grant's TTL and device authority, returning the owner and
 * the expiry. The device signs `private_publish`, which binds the challenge
 * nonce, the relic id and the lifetime, so a signed publish cannot be
 * pointed at another relic or another lifetime.
 */
export async function checkPrivatePublish(
  env: PrivateEnv,
  input: {
    readonly body: Record<string, unknown>;
    readonly relicId: string;
    readonly declaredSizeBytes: number;
  }
): Promise<{ owner: IdentityRecord; expiresAt: number; ttlDays: number }> {
  if (input.declaredSizeBytes <= 0) {
    // A zero-byte private relic would need its header size to pin the upload,
    // which the row does not keep, so it is refused rather than signed as a guess.
    throw new ProblemError('invalid_publish_metadata', {
      detail: 'A private relic needs content.',
    });
  }
  const ttl = input.body['ttl_days'];
  let ttlDays: number;
  if (ttl === undefined || ttl === null) {
    ttlDays = env.config.privateDefaultTtlDays;
  } else if (
    typeof ttl === 'number' &&
    Number.isSafeInteger(ttl) &&
    ttl >= 1 &&
    ttl <= env.config.privateMaxTtlDays
  ) {
    ttlDays = ttl;
  } else {
    throw new ProblemError('private_policy_violation', { policy_check: 'ttl' });
  }

  const auth = input.body['device_auth'] as Record<string, unknown> | undefined;
  if (
    typeof auth !== 'object' ||
    auth === null ||
    typeof auth['device_id'] !== 'string' ||
    typeof auth['nonce'] !== 'string' ||
    typeof auth['at'] !== 'number' ||
    typeof auth['signature'] !== 'string' ||
    auth['nonce'] !== input.body['challenge_nonce']
  ) {
    throw new ProblemError('invalid_device', { device_check: 'auth' });
  }

  const device = await env.store.getDevice(auth['device_id']);
  if (device === undefined) throw new ProblemError('device_not_found');
  if (device.revokedAt !== undefined) throw new ProblemError('device_revoked');
  if (device.notAfter <= env.now) {
    throw new ProblemError('device_revoked', { device_check: 'expired' });
  }
  if (
    Math.abs(env.now - auth['at']) >
    env.config.passkeyChallengeTtlSeconds * 1000
  ) {
    throw new ProblemError('invalid_device', { device_check: 'stale' });
  }

  let statement: Record<string, unknown>;
  try {
    statement = parseStatement('private_publish', {
      at: auth['at'],
      challenge_nonce: auth['nonce'],
      device_id: device.deviceId,
      relic_id: input.relicId,
      ttl_days: ttl ?? null,
    }) as unknown as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidStatementError) {
      throw new ProblemError('invalid_device', { device_check: error.check });
    }
    throw error;
  }
  const valid = await verifyStatement(
    decodeBase64url(device.sigPublicKey),
    statementBytes('private_publish', statement as never),
    auth['signature']
  );
  if (!valid)
    throw new ProblemError('invalid_device', { device_check: 'signature' });

  const owner = await env.store.getIdentity(device.ownerIdentityId);
  if (owner === undefined || owner.retiredAt !== undefined) {
    throw new ProblemError('owner_required', { relic_id: input.relicId });
  }
  return { owner, expiresAt: env.now + ttlDays * DAY_MS, ttlDays };
}
