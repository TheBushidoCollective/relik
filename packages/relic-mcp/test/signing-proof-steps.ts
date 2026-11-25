/* A real virtual-authenticator assertion over the supplied challenge. */
export async function pageSigningAssertion(args: {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string }>;
}) {
  const bytes = (text: string) =>
    Uint8Array.from(
      atob(
        text.replace(/-/g, '+').replace(/_/g, '/') +
          '='.repeat((4 - (text.length % 4)) % 4)
      ),
      (c) => c.charCodeAt(0)
    );
  const encode = (data: ArrayBuffer | null) => {
    if (data === null) return null;
    return btoa(String.fromCharCode(...new Uint8Array(data)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: bytes(args.challenge),
      rpId: args.rpId,
      allowCredentials: args.allowCredentials.map((c) => ({
        type: 'public-key',
        id: bytes(c.id),
      })),
      userVerification: 'required',
    },
  })) as PublicKeyCredential;
  if (!credential) throw new Error('passkey assertion cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle: encode(response.userHandle),
    },
  };
}
