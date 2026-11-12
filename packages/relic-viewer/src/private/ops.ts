/**
 * The key operations the private surfaces call, as one seam. Production uses
 * the real modules. A test passes stand-ins on `ViewerDeps.privateKeys`, so
 * nothing replaces a module process-wide and test files cannot leak into one
 * another.
 */

import type { ViewerDeps } from '../viewer.ts';
import { attest, loadIdentityState, unlock } from './keys.ts';
import { fetchAndDecryptVersion, fetchVersionKey } from './open.ts';

export interface PrivateKeyOps {
  readonly attest: typeof attest;
  readonly unlock: typeof unlock;
  readonly loadIdentityState: typeof loadIdentityState;
  readonly fetchVersionKey: typeof fetchVersionKey;
  readonly fetchAndDecryptVersion: typeof fetchAndDecryptVersion;
}

export const realPrivateKeys: PrivateKeyOps = {
  attest,
  unlock,
  loadIdentityState,
  fetchVersionKey,
  fetchAndDecryptVersion,
};

/** The key operations for this page: the injected ones, or the real modules. */
export function privateKeysOf(deps: ViewerDeps): PrivateKeyOps {
  return deps.privateKeys ?? realPrivateKeys;
}
