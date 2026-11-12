// relic-se: Secure Enclave helper for relic-mcp.
//
// One JSON request on stdin, one JSON response on stdout, exit 0. A refusal or
// failure prints {"error": "<code>"} on stdout and exits 1. Nothing else is
// written to stdout or stderr.
//
// Private keys never leave the Secure Enclave. A key is returned only as a
// blob: one role byte followed by the key's dataRepresentation, an opaque
// reference the Secure Enclave of this device can reload. No private scalar is
// ever printed, and the blob cannot be loaded on another device.
//
// The role byte is a misuse guard. CryptoKit does not bind a Secure Enclave
// key to its usage, so the same P-256 key would otherwise sign and perform
// ECDH alike. Any process running as this user can call the helper with either
// role, so the guard protects against mixed-up callers, not hostile ones.

import CryptoKit
import Foundation

struct HelperFailure: Error {
    let code: String
}

enum KeyRole: UInt8 {
    case signing = 0x01
    case agreement = 0x02
}

let maximumRequestBytes = 4 * 1024 * 1024
let agreementPublicKeyLength = 65
let agreementSecretLength = 32

func malformed() -> HelperFailure {
    HelperFailure(code: "malformed_request")
}

func readRequest() throws -> Data {
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let count = read(STDIN_FILENO, &chunk, chunk.count)
        if count == 0 {
            return data
        }
        if count < 0 {
            if errno == EINTR {
                continue
            }
            throw malformed()
        }
        if data.count + count > maximumRequestBytes {
            throw HelperFailure(code: "request_too_large")
        }
        data.append(chunk, count: count)
    }
}

func parseObject(_ data: Data) throws -> [String: Any] {
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw malformed()
    }
    guard let object = parsed as? [String: Any] else {
        throw malformed()
    }
    return object
}

func requireFields(_ object: [String: Any], _ names: Set<String>) throws {
    guard Set(object.keys) == names else {
        throw malformed()
    }
}

func stringField(_ object: [String: Any], _ name: String) throws -> String {
    guard let value = object[name] as? String else {
        throw malformed()
    }
    return value
}

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

// Accepts only the canonical unpadded base64url form, so a request has exactly
// one spelling and a re-encoded response compares equal to what was sent.
func decodeBase64URL(_ text: String) throws -> Data {
    let remainder = text.utf8.count % 4
    guard remainder != 1 else {
        throw malformed()
    }
    let standard = text
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
        + String(repeating: "=", count: (4 - remainder) % 4)
    guard let data = Data(base64Encoded: standard), base64URL(data) == text else {
        throw malformed()
    }
    return data
}

func encodeBlob(_ role: KeyRole, _ reference: Data) -> String {
    var envelope = Data([role.rawValue])
    envelope.append(reference)
    return envelope.base64EncodedString()
}

// Key blobs are canonical standard base64 with a role byte, the form stored in
// the device key store.
func decodeBlob(_ text: String, _ role: KeyRole) throws -> Data {
    guard let envelope = Data(base64Encoded: text), envelope.count > 1,
          envelope.base64EncodedString() == text else {
        throw malformed()
    }
    guard envelope[envelope.startIndex] == role.rawValue else {
        throw HelperFailure(code: "wrong_key_role")
    }
    return Data(envelope.dropFirst())
}

func requireSecureEnclave() throws {
    guard SecureEnclave.isAvailable else {
        throw HelperFailure(code: "secure_enclave_unavailable")
    }
}

func create() throws -> [String: Any] {
    try requireSecureEnclave()
    let signing: SecureEnclave.P256.Signing.PrivateKey
    let agreement: SecureEnclave.P256.KeyAgreement.PrivateKey
    do {
        signing = try SecureEnclave.P256.Signing.PrivateKey()
        agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey()
    } catch {
        throw HelperFailure(code: "create_failed")
    }
    return [
        "kem": [
            "blob": encodeBlob(.agreement, agreement.dataRepresentation),
            "public_key": base64URL(agreement.publicKey.x963Representation),
        ],
        "sig": [
            "blob": encodeBlob(.signing, signing.dataRepresentation),
            "public_key": base64URL(signing.publicKey.x963Representation),
        ],
    ]
}

func sign(blob: String, message: String) throws -> [String: Any] {
    let reference = try decodeBlob(blob, .signing)
    let payload = try decodeBase64URL(message)
    try requireSecureEnclave()
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: reference)
    } catch {
        throw HelperFailure(code: "invalid_key_blob")
    }
    let signature: P256.Signing.ECDSASignature
    do {
        signature = try key.signature(for: payload)
    } catch {
        throw HelperFailure(code: "sign_failed")
    }
    return ["signature": base64URL(signature.rawRepresentation)]
}

func agree(blob: String, peerPublicKey: String) throws -> [String: Any] {
    let reference = try decodeBlob(blob, .agreement)
    let peerBytes = try decodeBase64URL(peerPublicKey)
    guard peerBytes.count == agreementPublicKeyLength else {
        throw HelperFailure(code: "invalid_public_key")
    }
    try requireSecureEnclave()
    let key: SecureEnclave.P256.KeyAgreement.PrivateKey
    do {
        key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: reference)
    } catch {
        throw HelperFailure(code: "invalid_key_blob")
    }
    let peer: P256.KeyAgreement.PublicKey
    do {
        peer = try P256.KeyAgreement.PublicKey(x963Representation: peerBytes)
    } catch {
        throw HelperFailure(code: "invalid_public_key")
    }
    let shared: SharedSecret
    do {
        shared = try key.sharedSecretFromKeyAgreement(with: peer)
    } catch {
        throw HelperFailure(code: "key_agreement_failed")
    }
    let secret = shared.withUnsafeBytes { Data($0) }
    guard secret.count == agreementSecretLength else {
        throw HelperFailure(code: "key_agreement_failed")
    }
    return ["shared_secret": base64URL(secret)]
}

func runRequest() throws -> [String: Any] {
    let request = try parseObject(try readRequest())
    switch try stringField(request, "op") {
    case "available":
        try requireFields(request, ["op"])
        return ["available": SecureEnclave.isAvailable]
    case "create":
        try requireFields(request, ["op"])
        return try create()
    case "sign":
        try requireFields(request, ["op", "blob", "message"])
        return try sign(
            blob: try stringField(request, "blob"),
            message: try stringField(request, "message")
        )
    case "ecdh":
        try requireFields(request, ["op", "blob", "peer_public_key"])
        return try agree(
            blob: try stringField(request, "blob"),
            peerPublicKey: try stringField(request, "peer_public_key")
        )
    default:
        throw HelperFailure(code: "unknown_op")
    }
}

do {
    let response = try runRequest()
    let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    exit(0)
} catch let failure as HelperFailure {
    FileHandle.standardOutput.write(Data("{\"error\":\"\(failure.code)\"}".utf8))
    exit(1)
} catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"internal\"}".utf8))
    exit(1)
}
