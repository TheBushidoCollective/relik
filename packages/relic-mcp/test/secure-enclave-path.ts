/**
 * Real-hardware proof for the Secure Enclave helper. It creates a signing and a
 * key-agreement key, signs and verifies with WebCrypto, agrees a secret against
 * a WebCrypto peer, and checks the helper refuses misuse. Each helper call is a
 * fresh process, so every later call reloads its key from the blob alone.
 *
 * It needs a Mac with a Secure Enclave and a non-VM host. GitHub macOS runners
 * are VMs without one, so this runs by hand on physical hardware, never in CI.
 * It creates nothing in the keychain: the blobs live only in this process.
 */
import assert from 'node:assert/strict';
import {
  SecureEnclaveError,
  secureEnclaveHelper,
} from '../src/secure-enclave.ts';

const helper = secureEnclaveHelper();
if (helper === undefined) {
  throw new Error('no Secure Enclave helper prebuild exists for this platform');
}

const encoder = new TextEncoder();

function refusal(code: string): (error: unknown) => boolean {
  return (error) => error instanceof SecureEnclaveError && error.code === code;
}

// WebCrypto takes BufferSource over an ArrayBuffer, while the helper returns
// Uint8Array over ArrayBufferLike. Copying keeps the proof honest about types.
function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

assert.equal(
  await helper.available(),
  true,
  'this Mac reports no Secure Enclave'
);

const keys = await helper.create();
for (const pair of [keys.sig, keys.kem]) {
  assert.equal(
    pair.publicKey.length,
    65,
    'public key is an uncompressed P-256 point'
  );
  assert.equal(
    pair.publicKey[0],
    0x04,
    'public key starts with the 0x04 marker'
  );
}
assert.notEqual(
  keys.sig.blob,
  keys.kem.blob,
  'signing and agreement blobs differ'
);

const message = encoder.encode('relic secure enclave path');
const signature = await helper.sign(keys.sig.blob, message);
assert.equal(signature.length, 64, 'signature is raw r || s');

const verifier = await crypto.subtle.importKey(
  'raw',
  webCryptoBytes(keys.sig.publicKey),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['verify']
);
const ecdsa = { name: 'ECDSA', hash: 'SHA-256' };
assert.equal(
  await crypto.subtle.verify(
    ecdsa,
    verifier,
    webCryptoBytes(signature),
    message
  ),
  true
);
assert.equal(
  await crypto.subtle.verify(
    ecdsa,
    verifier,
    webCryptoBytes(signature),
    encoder.encode('tampered')
  ),
  false,
  'a signature over other bytes does not verify'
);

const peer = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveBits']
);
const peerPublic = new Uint8Array(
  await crypto.subtle.exportKey('raw', peer.publicKey)
);
const shared = await helper.ecdh(keys.kem.blob, peerPublic);
assert.equal(shared.length, 32, 'shared secret is the 32-byte x coordinate');

const enclavePublic = await crypto.subtle.importKey(
  'raw',
  webCryptoBytes(keys.kem.publicKey),
  { name: 'ECDH', namedCurve: 'P-256' },
  false,
  []
);
const expected = new Uint8Array(
  await crypto.subtle.deriveBits(
    { name: 'ECDH', public: enclavePublic },
    peer.privateKey,
    256
  )
);
assert.deepEqual(
  shared,
  expected,
  'enclave agreement matches the WebCrypto peer'
);

await assert.rejects(
  helper.sign(keys.kem.blob, message),
  refusal('wrong_key_role')
);
await assert.rejects(
  helper.ecdh(keys.sig.blob, peerPublic),
  refusal('wrong_key_role')
);
await assert.rejects(
  helper.sign('not base64!', message),
  refusal('malformed_request')
);
await assert.rejects(
  helper.ecdh(keys.kem.blob, peerPublic.subarray(0, 64)),
  refusal('invalid_public_key')
);

console.log('SECURE_ENCLAVE_PATH_OK');
