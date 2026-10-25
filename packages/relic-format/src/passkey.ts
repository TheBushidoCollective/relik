/**
 * Wire representations for WebAuthn passkeys (spec §4.2, §4.6).
 *
 * Decisions in the Relic viewer are bound to a WebAuthn passkey ceremony.
 * The wire types follow the W3C WebAuthn level 3 `toJSON()` representations,
 * where all binary fields are transported as unpadded base64url strings.
 */

/**
 * A credential descriptor referencing an existing passkey.
 * Used in `allowCredentials` and `excludeCredentials`.
 */
export interface PasskeyDescriptorJSON {
  readonly id: string;
  readonly type: 'public-key';
  readonly transports?: readonly string[];
}

/**
 * Options sent by the server for creating a new passkey credential
 * via `navigator.credentials.create()`.
 */
export interface CreationOptionsJSON {
  readonly challenge: string;
  readonly rp: {
    readonly id: string;
    readonly name: string;
  };
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
  };
  readonly pubKeyCredParams: readonly {
    readonly type: 'public-key';
    readonly alg: number;
  }[];
  readonly timeout?: number;
  readonly attestation?: string;
  readonly authenticatorSelection?: {
    readonly residentKey?: string;
    readonly userVerification?: string;
  };
  readonly excludeCredentials?: readonly PasskeyDescriptorJSON[];
}

/**
 * Options sent by the server for asserting an existing passkey
 * via `navigator.credentials.get()`.
 */
export interface RequestOptionsJSON {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout?: number;
  readonly userVerification?: string;
  readonly allowCredentials?: readonly PasskeyDescriptorJSON[];
}

/**
 * The client response from `navigator.credentials.create()` serialized to JSON.
 */
export interface RegistrationResponseJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: readonly string[];
  };
  readonly authenticatorAttachment?: string;
  readonly clientExtensionResults?: Record<string, unknown>;
}

/**
 * The client response from `navigator.credentials.get()` serialized to JSON.
 */
export interface AuthenticationResponseJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle: string | null;
  };
  readonly authenticatorAttachment?: string;
  readonly clientExtensionResults?: Record<string, unknown>;
}
