---
topic: webauthn-prf-and-device-keys-measured
created_at: 2026-11-11
updated_at: 2026-11-11
---
Measured on 2026-11-11 on one Mac (macOS 27, Apple silicon) with scratch probes outside the repo, not with repo tests. Anything about a platform not listed here is unmeasured. The private-share design in `docs/plans/private-shares/README.md` depends on these facts, and its section 2 corrections cite them.

## Environment

- Chrome 157.0.8103.39, and HeadlessChrome 149.0.7827.55 (`chromium_headless_shell-1228`).
- A CDP virtual authenticator on `http://localhost`: protocol `ctap2`, `ctap2Version` `ctap2_1`, transport `internal`, with `hasResidentKey`, `hasUserVerification`, `isUserVerified`, `automaticPresenceSimulation`, and `hasPrf: true` where a probe says so.
- Bun 1.4.4, Node 18.20.8 (with the repo's `webcrypto` global shim), and Node 24.15.0.
- Swift 6.4.2, for the Secure Enclave probe.

## WebAuthn PRF

**A credential created without `prf` returns no PRF result at assertion.** A credential created with `prf` returns `enabled: true` at creation and a 32-byte result at creation (with `eval`) and at assertion. The result is identical across assertions with one salt and differs across salts. Assertion flags are `0x05`, and authenticator data is 37 bytes with or without PRF.

The consequence is that PRF capability is fixed when a credential is created. The operative test is a PRF result at an assertion with user verification required, not the `enabled` flag at creation.

## Serialization can carry PRF output

**`PublicKeyCredential.toJSON().clientExtensionResults` differs by browser.** In Chrome 157 it is `{"prf":{"results":{"first":"..."}}}`. In HeadlessChrome 149 it is `{"prf":{}}`.

The consequence is that any code which serializes a credential with `toJSON` can send PRF output to the server. The design keeps PRF output out of every request body and tests that as an invariant, not as a platform guarantee.

## WebCrypto import and derivation

**A JWK with only `d` is refused.** In Chrome 149 and 157 it fails with "The required JWK member x was missing". PKCS#8 for P-256 without the public key imports in Chrome 149 and 157, and exports `x` and `y`.

Bun 1.4.4, Node 18.20.8, and Node 24.15.0 each pass the following: P-256 ECDH raw export (65 bytes, prefix `0x04`), ECDH agreement, JWK re-import with `d`, `x` and `y`, ECDSA signatures of 64 bytes, HMAC-SHA256, and AES-GCM.

The consequence is that a public key cannot be derived deterministically from a PRF scalar with portable WebCrypto. The design generates random keypairs and wraps their private JWK under a key derived from PRF output.

**Not measured:** WebKit (Safari) and Gecko (Firefox) for every line in this section, including PKCS#8 without the public key.

## Secure Enclave on this Mac

**An ad-hoc signed CLI with no entitlements reports `SecureEnclave.isAvailable = true`.** It creates CryptoKit Secure Enclave P-256 signing and key-agreement keys and persists each one as a 284-byte blob. A second, separately built binary with a different CDHash reuses those blobs in a later process. It signs with a 64-byte raw signature that verifies, and its ECDH result matches the first binary's.

The consequence is that a Secure Enclave key blob can outlive the binary that created it on this Mac, which is the basis for the helper in plan section 4.17.

**Not measured:** Intel Macs, virtual machines (the plan records that CI's macOS runners are VMs without a Secure Enclave), Gatekeeper behavior for a distributed prebuild, and any key that survives the loss of the device.

## Keychain

`man security` says `add-generic-password` takes the secret through `-w` or `-X` on the command line, or prompts on a TTY. The plan also records that items created that way trust `/usr/bin/security`, so other processes running as the same user can read them back. That trust claim is cited from the plan and was not measured here.

The consequence is that the design keeps the device key in a file or the Secure Enclave, and does not use the Keychain.

## What this does not settle

- Real providers: iCloud Keychain, Google Password Manager, Windows Hello, and security keys, on each platform. Open questions are whether each returns PRF for a credential created with `prf`, accepts a replacement creation with an empty exclude list, and returns PRF over hybrid transport (plan section 8, item 1).
- Safari and Firefox WebCrypto for the identity operations.
- Browser memory limits for rekeying a large private relic.

Related: [[browser-crypto-and-large-file-constraints]], [[rfc8188-container-facts-and-implementation-landscape]].
