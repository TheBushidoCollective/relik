/**
 * The JSON shapes private shares put on the wire (`docs/plans/private-shares`
 * section 4.6). Every field is snake_case, every byte string is base64url, and
 * every hex value is lowercase. These are types only: the runtime checks live in
 * `private.ts` and in the service.
 *
 * Reachable only through `@relic/format/private`, never through the index.
 */

import type { AuthenticationResponseJSON } from './passkey.ts';
import type { SignedStatementBody, StatementKind } from './private.ts';

export type AttestPurpose =
  | 'identity_register'
  | 'identity_bind'
  | 'identity_settings'
  | 'access_request'
  | 'grant'
  | 'revoke'
  | 'delete'
  | 'device_approve'
  | 'device_revoke'
  | 'recovery_designate';

export interface SignedStatementJSON {
  readonly kind: StatementKind;
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
}

export interface AttestationBundleJSON {
  readonly nonce: string;
  readonly statements: readonly SignedStatementJSON[];
  readonly credential: AuthenticationResponseJSON;
}

export interface DeviceAuthJSON {
  readonly device_id: string;
  readonly nonce: string;
  readonly at: number;
  readonly signature: string;
}

export interface IdentityPublicJSON {
  readonly identity_id: string;
  readonly email: string;
  readonly kem_public_key: string;
  readonly sig_public_key: string;
  readonly created_at: string;
  readonly retired_at: string | null;
}

export interface PartyJSON {
  readonly email: string;
  readonly identity: IdentityPublicJSON;
}

export interface IdentityStateJSON {
  readonly identity:
    | (IdentityPublicJSON & {
        readonly credentials: readonly {
          readonly credential_id: string;
          readonly encrypted_bundle: string;
          readonly bound_at: string;
        }[];
        readonly recovery: RecoveryJSON | null;
        readonly access_log_retention_days: number;
        readonly recipients_epoch: number;
      })
    | null;
  readonly passkeys: readonly {
    readonly credential_id: string;
    readonly bound: boolean;
  }[];
}

export interface RecoveryJSON extends PartyJSON {
  readonly designated_at: string;
  readonly designation: {
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
  };
}

/**
 * The recovery fields of a recipients or device-context answer. `recovery` is the
 * holder in force. `recovery_statement` is the owner's newest signed designation,
 * which is a removal (all three party fields null) when the holder was removed.
 * It sits beside `recovery` on the answer, not inside it, because it is returned
 * even when there is no holder to name.
 */
export interface RecoveryAnswerJSON {
  readonly recovery: RecoveryJSON | null;
  readonly recovery_statement?: SignedStatementBody | null;
}

export interface DevicePublicJSON {
  readonly device_id: string;
  readonly owner_identity_id: string;
  readonly kem_public_key: string;
  readonly sig_public_key: string;
  readonly label: string;
  readonly backend: 'secure-enclave' | 'file';
  readonly not_after: number;
  readonly certified_at: string;
  readonly revoked_at: string | null;
  readonly cert: {
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
  };
  /** The owner's signed revocation of this device, or null. Absent on answers from a service that predates it. */
  readonly revocation?: SignedStatementBody | null;
}

export interface WrapJSON {
  readonly recipient_key_id: string;
  readonly version: number;
  readonly enc: string;
  readonly ct: string;
}

export interface BackfillWrapJSON extends WrapJSON {
  readonly relic_id: string;
}

/**
 * The signed seal of one version. Its `key_commitment` (section 4.1) commits to
 * the version key the wraps carry: an opener verifies the unwrapped key against
 * it, and refuses a key that does not match, before the key is used.
 */
export interface SealJSON {
  readonly statement: Record<string, unknown>;
  readonly signature: string;
  readonly signer_kind: 'device' | 'identity';
}

export interface GrantJSON {
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
  readonly granted_at: string;
  readonly revoked_at: string | null;
  /** The owner's signed revocation of this grant, or null. Revoked grants stay in the roster with it. */
  readonly revocation?: SignedStatementBody | null;
  readonly grantee: PartyJSON;
}

export interface KeyJSON {
  readonly relic_id: string;
  readonly version: number;
  readonly wrap: WrapJSON;
  readonly seal: SealJSON;
  readonly signer:
    | { readonly kind: 'identity' }
    | { readonly kind: 'device'; readonly device: DevicePublicJSON };
  readonly owner: PartyJSON;
}

export type AccessRole =
  | 'owner'
  | 'grantee'
  | 'recovery'
  | 'revoked'
  | 'requested'
  | 'declined'
  | 'none';

export interface PrivateAccessJSON {
  readonly access: 'private';
  readonly relic_id: string;
  readonly current_version: number;
  readonly sealed_version: number | null;
  readonly expires_at: string;
  /** Null for none, requested, declined. */
  readonly owner: PartyJSON | null;
  readonly recovery: PartyJSON | null;
  readonly me: {
    readonly role: AccessRole;
    readonly identity: IdentityPublicJSON | null;
    readonly readable_versions: readonly number[];
    readonly deleted_versions: readonly number[];
  };
}

export interface PublicAccessJSON {
  readonly access: 'public';
  readonly relic_id: string;
  readonly owned_by_me: boolean;
}

export interface AccessEventJSON {
  readonly event_id: string;
  readonly at: string;
  readonly kind: 'request' | 'grant' | 'revoke' | 'wrap_fetch' | 'delete';
  readonly relic_id: string;
  readonly version: number | null;
  readonly actor: {
    readonly email: string | null;
    readonly identity_id: string | null;
    readonly device_id: string | null;
  };
  readonly subject_identity_id: string | null;
}
