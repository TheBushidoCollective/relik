import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SecureEnclaveHelper {
  available(): Promise<boolean>;
  create(): Promise<{
    kem: { blob: string; publicKey: Uint8Array };
    sig: { blob: string; publicKey: Uint8Array };
  }>;
  sign(blob: string, message: Uint8Array): Promise<Uint8Array>;
  ecdh(blob: string, peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

/**
 * A refusal or failure reported by the helper. The code is the helper's own
 * `{"error": "<code>"}` value, never key material.
 */
export class SecureEnclaveError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Secure Enclave helper refused: ${code}`);
    this.name = 'SecureEnclaveError';
    this.code = code;
  }
}

const helperTimeoutMs = 30_000;
const responseLimitBytes = 64 * 1024;
const base64URLPattern = /^[A-Za-z0-9_-]*$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

function prebuildTarget(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  if (process.arch === 'arm64') return 'darwin-arm64';
  if (process.arch === 'x64') return 'darwin-x64';
  return undefined;
}

function malformedResponse(): SecureEnclaveError {
  return new SecureEnclaveError('malformed_response');
}

function recordOf(
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedResponse();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw malformedResponse();
  }
  return record;
}

function decodeBase64URL(value: unknown, length: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    !base64URLPattern.test(value) ||
    value.length % 4 === 1
  ) {
    throw malformedResponse();
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length) throw malformedResponse();
  return new Uint8Array(bytes);
}

function publicKeyOf(value: unknown): Uint8Array {
  const bytes = decodeBase64URL(value, 65);
  if (bytes[0] !== 0x04) throw malformedResponse();
  return bytes;
}

function keyPairOf(value: unknown): { blob: string; publicKey: Uint8Array } {
  const record = recordOf(value, ['blob', 'public_key']);
  if (typeof record.blob !== 'string' || !base64Pattern.test(record.blob)) {
    throw malformedResponse();
  }
  return { blob: record.blob, publicKey: publicKeyOf(record.public_key) };
}

function invoke(
  path: string,
  request: Record<string, string>
): Promise<Record<string, unknown>> {
  // The Promise executor form keeps this on the Node 18 floor.
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], {
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new SecureEnclaveError('helper_timeout')));
    }, helperTimeoutMs);

    // A helper that refuses early closes stdin first. Its exit code and
    // response decide the outcome, so the write error is not a second failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));

    child.stdout.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > responseLimitBytes) {
        child.kill('SIGKILL');
        settle(() => reject(new SecureEnclaveError('response_too_large')));
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', () => {
      settle(() => reject(new SecureEnclaveError('spawn_failed')));
    });

    child.on('close', (code) => {
      settle(() => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(malformedResponse());
          return;
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          reject(malformedResponse());
          return;
        }
        const record = parsed as Record<string, unknown>;
        if (code === 0) {
          resolve(record);
          return;
        }
        if (code === 1 && typeof record.error === 'string') {
          reject(new SecureEnclaveError(record.error));
          return;
        }
        reject(new SecureEnclaveError('helper_failed'));
      });
    });
  });
}

function helperAt(path: string): SecureEnclaveHelper {
  return {
    async available() {
      const response = recordOf(await invoke(path, { op: 'available' }), [
        'available',
      ]);
      if (typeof response.available !== 'boolean') throw malformedResponse();
      return response.available;
    },

    async create() {
      const response = recordOf(await invoke(path, { op: 'create' }), [
        'kem',
        'sig',
      ]);
      return {
        kem: keyPairOf(response.kem),
        sig: keyPairOf(response.sig),
      };
    },

    async sign(blob, message) {
      const response = recordOf(
        await invoke(path, {
          op: 'sign',
          blob,
          message: Buffer.from(message).toString('base64url'),
        }),
        ['signature']
      );
      return decodeBase64URL(response.signature, 64);
    },

    async ecdh(blob, peerPublicKey) {
      const response = recordOf(
        await invoke(path, {
          op: 'ecdh',
          blob,
          peer_public_key: Buffer.from(peerPublicKey).toString('base64url'),
        }),
        ['shared_secret']
      );
      return decodeBase64URL(response.shared_secret, 32);
    },
  };
}

/**
 * The Secure Enclave helper for this platform, or undefined when no prebuild
 * ships for it. Each call spawns the helper; the helper holds no state between
 * calls, so every key operation reloads its key from the blob it is given.
 */
export function secureEnclaveHelper(): SecureEnclaveHelper | undefined {
  const target = prebuildTarget();
  if (target === undefined) return undefined;
  const path = fileURLToPath(
    new URL(`../prebuilds/${target}/relic-se`, import.meta.url)
  );
  if (!existsSync(path)) return undefined;
  return helperAt(path);
}
