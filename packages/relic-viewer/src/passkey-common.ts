/**
 * WebAuthn wire conversion and ceremony coordination shared between lazy chunks.
 *
 * Imported only by dynamic-import chunks (decision-panel and passkey-sign-in).
 * Never import this module from viewer.js or the app shell.
 */

import type {
  AuthenticationResponseJSON,
  CreationOptionsJSON,
  PasskeyDescriptorJSON,
  RegistrationResponseJSON,
  RequestOptionsJSON,
} from '@relic/format';

/* ---------- WebAuthn JSON and binary ---------- */

const B64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url, as every WebAuthn wire field is. */
export function base64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  let accumulator = 0;
  let held = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0xffff;
    held += 8;
    while (held >= 6) {
      held -= 6;
      out += B64URL[(accumulator >>> held) & 0x3f];
    }
  }
  if (held > 0) out += B64URL[(accumulator << (6 - held)) & 0x3f];
  return out;
}

/** The inverse, refusing anything outside the alphabet (padding included). */
export function base64urlDecode(text: string): ArrayBuffer {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let accumulator = 0;
  let held = 0;
  let index = 0;
  for (const ch of text) {
    const value = B64URL.indexOf(ch);
    if (value < 0) throw new TypeError('not unpadded base64url');
    accumulator = ((accumulator << 6) | value) & 0xffff;
    held += 6;
    if (held >= 8) {
      held -= 8;
      out[index] = (accumulator >>> held) & 0xff;
      index += 1;
    }
  }
  return out.buffer;
}

export function descriptors(
  list: readonly PasskeyDescriptorJSON[] | undefined
): PublicKeyCredentialDescriptor[] {
  return (list ?? []).map((entry) => ({
    type: 'public-key',
    id: base64urlDecode(entry.id),
    ...(entry.transports === undefined
      ? {}
      : { transports: [...entry.transports] as AuthenticatorTransport[] }),
  }));
}

export function creationOptionsFromJSON(
  json: CreationOptionsJSON
): PublicKeyCredentialCreationOptions {
  const selection = json.authenticatorSelection;
  return {
    challenge: base64urlDecode(json.challenge),
    rp: { id: json.rp.id, name: json.rp.name },
    user: {
      id: base64urlDecode(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: json.pubKeyCredParams.map((param) => ({
      type: 'public-key',
      alg: param.alg,
    })),
    excludeCredentials: descriptors(json.excludeCredentials),
    ...(json.timeout === undefined ? {} : { timeout: json.timeout }),
    ...(json.attestation === undefined
      ? {}
      : { attestation: json.attestation as AttestationConveyancePreference }),
    ...(selection === undefined
      ? {}
      : {
          authenticatorSelection: {
            ...(selection.residentKey === undefined
              ? {}
              : {
                  residentKey: selection.residentKey as ResidentKeyRequirement,
                }),
            ...(selection.requireResidentKey === undefined
              ? {}
              : {
                  requireResidentKey: selection.requireResidentKey,
                }),
            ...(selection.userVerification === undefined
              ? {}
              : {
                  userVerification:
                    selection.userVerification as UserVerificationRequirement,
                }),
          },
        }),
  };
}

export function requestOptionsFromJSON(
  json: RequestOptionsJSON
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64urlDecode(json.challenge),
    rpId: json.rpId,
    allowCredentials: descriptors(json.allowCredentials),
    ...(json.timeout === undefined ? {} : { timeout: json.timeout }),
    ...(json.userVerification === undefined
      ? {}
      : {
          userVerification:
            json.userVerification as UserVerificationRequirement,
        }),
  };
}

interface CredentialShape {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: unknown;
}

function credentialShape(credential: Credential): CredentialShape {
  const shaped = credential as unknown as Partial<CredentialShape>;
  if (
    typeof shaped.id !== 'string' ||
    !(shaped.rawId instanceof ArrayBuffer) ||
    typeof shaped.response !== 'object' ||
    shaped.response === null
  ) {
    throw new TypeError('not a public key credential');
  }
  return shaped as CredentialShape;
}

function bufferField(source: unknown, name: string): ArrayBuffer {
  const value: unknown = Reflect.get(source as object, name);
  if (!(value instanceof ArrayBuffer)) {
    throw new TypeError(`credential response has no ${name}`);
  }
  return value;
}

export function registrationResponseToJSON(
  credential: Credential
): RegistrationResponseJSON {
  const shaped = credentialShape(credential);
  const response = shaped.response as {
    getTransports?: () => string[];
  };
  const transports =
    typeof response.getTransports === 'function'
      ? response.getTransports()
      : undefined;
  return {
    id: shaped.id,
    rawId: base64urlEncode(shaped.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: base64urlEncode(bufferField(response, 'clientDataJSON')),
      attestationObject: base64urlEncode(
        bufferField(response, 'attestationObject')
      ),
      ...(transports === undefined ? {} : { transports }),
    },
  };
}

export function authenticationResponseToJSON(
  credential: Credential
): AuthenticationResponseJSON {
  const shaped = credentialShape(credential);
  const response = shaped.response;
  const handle: unknown = Reflect.get(response as object, 'userHandle');
  return {
    id: shaped.id,
    rawId: base64urlEncode(shaped.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: base64urlEncode(bufferField(response, 'clientDataJSON')),
      authenticatorData: base64urlEncode(
        bufferField(response, 'authenticatorData')
      ),
      signature: base64urlEncode(bufferField(response, 'signature')),
      userHandle:
        handle instanceof ArrayBuffer && handle.byteLength > 0
          ? base64urlEncode(handle)
          : null,
    },
  };
}

export const ICON_KEY =
  'M5 5.5a3 3 0 1 1 5.6 1.5l4.4 4.4V14h-2.2v-1.3h-1.3v-1.3h-1.3L7.5 8.6A3 3 0 0 1 5 5.5zm2.5-1.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z';

/** The slice of `navigator.credentials` the ceremony uses. */
export interface CredentialsLike {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

export function el(
  tag: string,
  className?: string,
  text?: string
): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined && className.length > 0) {
    node.className = className;
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function glyph(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

export function pressable(
  className: string,
  label: string,
  onClick: () => void,
  iconPath?: string
): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  if (iconPath !== undefined) {
    node.append(glyph(iconPath), el('span', '', label));
  } else {
    node.textContent = label;
  }
  node.addEventListener('click', onClick);
  return node;
}

/** Strips the bidirectional controls an untrusted address could carry. */
export function plain(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '');
}

export function parseDescriptors(
  value: unknown
): readonly PasskeyDescriptorJSON[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError('descriptors');
  return value.map((entry: unknown) => {
    const id: unknown = Reflect.get(entry as object, 'id');
    const transports: unknown = Reflect.get(entry as object, 'transports');
    if (typeof id !== 'string') throw new TypeError('descriptor id');
    return {
      id,
      type: 'public-key' as const,
      ...(Array.isArray(transports) &&
      transports.every((t): t is string => typeof t === 'string')
        ? { transports }
        : {}),
    };
  });
}

export function parseRequestOptions(
  value: unknown
): RequestOptionsJSON | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.challenge !== 'string' || typeof o.rpId !== 'string') {
    return undefined;
  }
  try {
    const allow = parseDescriptors(o.allowCredentials);
    return {
      challenge: o.challenge,
      rpId: o.rpId,
      ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
      ...(typeof o.userVerification === 'string'
        ? { userVerification: o.userVerification }
        : {}),
      ...(allow === undefined ? {} : { allowCredentials: allow }),
    };
  } catch {
    return undefined;
  }
}

export function parseCreationOptions(
  value: unknown
): CreationOptionsJSON | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const rp = o.rp as Record<string, unknown> | undefined;
  const user = o.user as Record<string, unknown> | undefined;
  if (
    typeof o.challenge !== 'string' ||
    typeof rp?.id !== 'string' ||
    typeof rp.name !== 'string' ||
    typeof user?.id !== 'string' ||
    typeof user.name !== 'string' ||
    typeof user.displayName !== 'string' ||
    !Array.isArray(o.pubKeyCredParams)
  ) {
    return undefined;
  }
  try {
    const params = o.pubKeyCredParams.map((entry: unknown) => {
      const alg: unknown = Reflect.get(entry as object, 'alg');
      if (typeof alg !== 'number') throw new TypeError('alg');
      return { type: 'public-key' as const, alg };
    });
    const exclude = parseDescriptors(o.excludeCredentials);
    const selection = o.authenticatorSelection as
      | Record<string, unknown>
      | undefined;
    return {
      challenge: o.challenge,
      rp: { id: rp.id, name: rp.name },
      user: { id: user.id, name: user.name, displayName: user.displayName },
      pubKeyCredParams: params,
      ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
      ...(typeof o.attestation === 'string'
        ? { attestation: o.attestation }
        : {}),
      ...(typeof selection === 'object' && selection !== null
        ? {
            authenticatorSelection: {
              ...(typeof selection.residentKey === 'string'
                ? { residentKey: selection.residentKey }
                : {}),
              ...(typeof selection.requireResidentKey === 'boolean'
                ? { requireResidentKey: selection.requireResidentKey }
                : {}),
              ...(typeof selection.userVerification === 'string'
                ? { userVerification: selection.userVerification }
                : {}),
            },
          }
        : {}),
      ...(exclude === undefined ? {} : { excludeCredentials: exclude }),
    };
  } catch {
    return undefined;
  }
}

/** Why a ceremony ended without an answer, from the DOMException's name. */
export function ceremonyCode(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'not_allowed';
  if (name === 'InvalidStateError') return 'passkey_exists';
  if (name === 'SecurityError') return 'passkey_security';
  return 'passkey_failed';
}

const CEREMONY_ABORTED = 'A newer passkey request replaced this one';
let current: AbortController | undefined;
export function ceremonySignal(): AbortSignal {
  current?.abort(new DOMException(CEREMONY_ABORTED, 'AbortError'));
  current = new AbortController();
  return current.signal;
}

export const COPY_LINK_REQUIRED_LEAD =
  'A first passkey can only be added right after you sign in from an email.';
export const COPY_LINK_FINE =
  'This stops anyone holding an older sign-in from adding a passkey as you.';
export const COPY_LINK_SEND = 'Email me a new code';
export const COPY_LINK_FAILED =
  'Relic could not send the email just now. Try again later.';

/** The shell's answer after emailing a new link on a surface's behalf. Resolves, never rejects. */
export type LinkRequestOutcome =
  | {
      readonly kind: 'sent';
      readonly message: string;
      readonly warning?: string;
      /**
       * Builds the field for the code in that email. The surface appends it under the message and
       * continues from `onVerified`, which runs after the session cookie is set, the offer marker is
       * consumed, and other tabs are told.
       */
      readonly codeEntry?: (onVerified: (email: string) => void) => HTMLElement;
    }
  | { readonly kind: 'failed' };
