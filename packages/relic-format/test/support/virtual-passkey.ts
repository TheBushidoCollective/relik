/**
 * A WebAuthn authenticator for tests: a P-256 key that answers `webauthn.get`
 * the way a platform passkey does. It builds `authenticatorData` and
 * `clientDataJSON`, signs their SHA-256 with ECDSA, and returns the DER form
 * browsers produce. Every field a test needs to break is a parameter.
 */

import { encodeBase64url } from '../../src/private.ts';
import type { AuthenticationResponseJSON } from '../../src/passkey.ts';

export interface AssertionOptions {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  /** The flags byte. Defaults to UP and UV (0x05). */
  readonly flags?: number;
  /** Extension data appended after the counter. Set the ED flag yourself. */
  readonly extensions?: Uint8Array;
  readonly type?: string;
  readonly crossOrigin?: boolean;
}

export interface VirtualPasskey {
  readonly credentialId: string;
  readonly publicKeyJwk: JsonWebKey;
  assert(options: AssertionOptions): Promise<AuthenticationResponseJSON>;
}

/** A fresh passkey with its own key pair and credential id. */
export async function virtualPasskey(): Promise<VirtualPasskey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const credentialId = encodeBase64url(
    crypto.getRandomValues(new Uint8Array(16))
  );
  return {
    credentialId,
    publicKeyJwk,
    async assert(
      options: AssertionOptions
    ): Promise<AuthenticationResponseJSON> {
      const clientData = utf8(
        JSON.stringify({
          type: options.type ?? 'webauthn.get',
          challenge: options.challenge,
          origin: options.origin,
          crossOrigin: options.crossOrigin ?? false,
        })
      );
      const rpIdHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', toBuffer(utf8(options.rpId)))
      );
      const authData = concat(
        rpIdHash,
        Uint8Array.of(options.flags ?? 0x05),
        Uint8Array.of(0, 0, 0, 1),
        options.extensions ?? new Uint8Array(0)
      );
      const clientHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', toBuffer(clientData))
      );
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          toBuffer(concat(authData, clientHash))
        )
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          authenticatorData: encodeBase64url(authData),
          signature: encodeBase64url(derEncode(raw)),
          userHandle: null,
        },
      };
    },
  };
}

/** The DER `SEQUENCE { r, s }` of a 64-byte P1363 signature, as browsers return it. */
export function derEncode(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32, 64));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

function derInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const body = value.subarray(start);
  const pad = (body[0] ?? 0) & 0x80 ? Uint8Array.of(0) : new Uint8Array(0);
  return concat(Uint8Array.of(0x02, pad.length + body.length), pad, body);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A copy of exactly this view's bytes, as WebCrypto requires. */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
