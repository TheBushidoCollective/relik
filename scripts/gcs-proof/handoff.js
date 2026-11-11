#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const INFO = 'relic-gcs-proof-handoff v1';
const KEY_JSON_LIMIT = 1024;
const KEY_PEM_LIMIT = 2048;
const SEALED_LIMIT = 16 * 1024;
const TOKEN_LIMIT = 4096;
// Printable quotes and backslashes can double in JSON; include metadata too.
const PLAINTEXT_LIMIT = 2 * TOKEN_LIMIT + 256;
const TOKEN_PATTERN = /^[\x21-\x7e]{20,4096}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CONTEXT =
  /^run=([1-9][0-9]{0,18}) attempt=([1-9][0-9]{0,2}) account=(rgp-([1-9][0-9]{0,18})-([1-9][0-9]{0,2})@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com) expires=([1-9][0-9]{0,15})$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

// Never follow a symlink or read more than the limit, even if the file grows.
function readBounded(path, limit, secret = false) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = fstatSync(fd);
    requireValue(stat.isFile(), 'input must be a regular file');
    requireValue(!secret || (stat.mode & 0o077) === 0, 'insecure input mode');
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    requireValue(total <= limit, 'input exceeds its byte limit');
    return buffer.subarray(0, total);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Reserve every output before writing any of them. O_EXCL prevents overwrite
// and symlink substitution; only files created here are removed on failure.
function writeNewFiles(outputs) {
  const opened = [];
  try {
    for (const [path, bytes] of outputs) {
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      opened.push({ path, fd, bytes });
      fchmodSync(fd, 0o600);
    }
    for (const output of opened) writeFileSync(output.fd, output.bytes);
    for (const output of opened) {
      closeSync(output.fd);
      output.fd = undefined;
    }
  } catch (error) {
    for (const output of opened) {
      if (output.fd !== undefined) {
        try {
          closeSync(output.fd);
        } catch {
          // Continue removing the outputs this process created.
        }
      }
      try {
        unlinkSync(output.path);
      } catch {
        // Keep the original failure.
      }
    }
    throw error;
  }
}

function parseObject(raw, fields) {
  const text = raw.toString('utf8');
  const value = JSON.parse(text);
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid JSON object'
  );
  // Comparing with our own compact serialization also rejects duplicate keys.
  requireValue(
    text === JSON.stringify(value) || text === `${JSON.stringify(value)}\n`,
    'noncanonical JSON'
  );
  const actual = Object.keys(value).sort();
  requireValue(
    actual.length === fields.length &&
      [...fields].sort().every((name, index) => name === actual[index]),
    'invalid JSON fields'
  );
  return value;
}

function decodeBase64(value, min, max) {
  requireValue(typeof value === 'string', 'invalid base64');
  requireValue(value.length <= 4 * Math.ceil(max / 3), 'base64 exceeds limit');
  requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(value), 'invalid base64');
  const decoded = Buffer.from(value, 'base64');
  requireValue(
    decoded.length >= min &&
      decoded.length <= max &&
      decoded.toString('base64') === value,
    'invalid base64'
  );
  return decoded;
}

function publicKey(der) {
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  requireValue(key.asymmetricKeyType === 'x25519', 'key must be X25519');
  requireValue(
    key.export({ format: 'der', type: 'spki' }).equals(der),
    'noncanonical public key'
  );
  return key;
}

function privateKey(pem) {
  const key = createPrivateKey(pem);
  requireValue(key.asymmetricKeyType === 'x25519', 'key must be X25519');
  return key;
}

function contextBytes(context) {
  const match = CONTEXT.exec(context);
  requireValue(match !== null && match[0] === context, 'invalid context');
  const [, run, attempt, account, accountRun, accountAttempt, , expires] =
    match;
  requireValue(
    run === accountRun && attempt === accountAttempt,
    'context mismatch'
  );
  requireValue(account.split('@')[0].length <= 30, 'invalid account');
  requireValue(Number.isSafeInteger(Number(expires)), 'invalid expiry');
  if (process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_ATTEMPT) {
    requireValue(
      process.env.GITHUB_RUN_ID === run &&
        process.env.GITHUB_RUN_ATTEMPT === attempt,
      'context does not match this run attempt'
    );
  }
  return Buffer.from(`${INFO}\n${context}`, 'utf8');
}

function validateExpiry(value) {
  const match = typeof value === 'string' ? RFC3339_UTC.exec(value) : null;
  requireValue(match !== null && match[0] === value, 'invalid expiry');
  const timestamp = Date.parse(value);
  requireValue(Number.isFinite(timestamp), 'invalid expiry');
  requireValue(
    new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19),
    'invalid expiry'
  );
}

function validateToken(token) {
  const match = typeof token === 'string' ? TOKEN_PATTERN.exec(token) : null;
  requireValue(match !== null && match[0] === token, 'invalid token');
}

function deriveKey(privatePart, publicPart, ephemeralDer, recipientDer) {
  const secret = diffieHellman({
    privateKey: privatePart,
    publicKey: publicPart,
  });
  try {
    const salt = createHash('sha256')
      .update(ephemeralDer)
      .update(recipientDer)
      .digest();
    return Buffer.from(hkdfSync('sha256', secret, salt, INFO, 32));
  } finally {
    secret.fill(0);
  }
}

function keygen(options) {
  const { privateKey: privatePart, publicKey: publicPart } =
    generateKeyPairSync('x25519');
  const pem = privatePart.export({ type: 'pkcs8', format: 'pem' });
  const der = publicPart.export({ type: 'spki', format: 'der' });
  const data = JSON.stringify({ version: 1, x25519: der.toString('base64') });
  requireValue(
    Buffer.byteLength(data) <= KEY_JSON_LIMIT,
    'public key exceeds limit'
  );
  writeNewFiles([
    [join(options.dir, 'handoff-key.pem'), pem],
    [join(options.dir, 'handoff-key.json'), data],
  ]);
}

function seal(options) {
  const aad = contextBytes(options.context);
  const keyFile = parseObject(
    readBounded(options['key-json'], KEY_JSON_LIMIT),
    ['version', 'x25519']
  );
  requireValue(keyFile.version === 1, 'invalid public key version');
  const recipientDer = decodeBase64(keyFile.x25519, 44, 44);
  const recipient = publicKey(recipientDer);
  const tokenBytes = readBounded(options['token-file'], TOKEN_LIMIT, true);
  const token = tokenBytes.toString('utf8');
  validateToken(token);
  validateExpiry(options['expire-time']);
  const plaintext = Buffer.from(
    JSON.stringify({ token, expire_time: options['expire-time'] }),
    'utf8'
  );
  requireValue(plaintext.length <= PLAINTEXT_LIMIT, 'plaintext exceeds limit');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralDer = ephemeral.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const key = deriveKey(
    ephemeral.privateKey,
    recipient,
    ephemeralDer,
    recipientDer
  );
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const sealed = JSON.stringify({
      version: 1,
      ephemeral: ephemeralDer.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
    requireValue(
      Buffer.byteLength(sealed) <= SEALED_LIMIT,
      'sealed file exceeds limit'
    );
    writeNewFiles([[options.out, sealed]]);
  } finally {
    key.fill(0);
    plaintext.fill(0);
    tokenBytes.fill(0);
  }
}

function open(options) {
  const aad = contextBytes(options.context);
  const secret = privateKey(
    readBounded(options['key-pem'], KEY_PEM_LIMIT, true)
  );
  const recipientDer = createPublicKey(secret).export({
    format: 'der',
    type: 'spki',
  });
  const sealed = parseObject(readBounded(options.sealed, SEALED_LIMIT), [
    'version',
    'ephemeral',
    'iv',
    'ciphertext',
    'tag',
  ]);
  requireValue(sealed.version === 1, 'invalid sealed version');
  const ephemeralDer = decodeBase64(sealed.ephemeral, 44, 44);
  const ephemeral = publicKey(ephemeralDer);
  const iv = decodeBase64(sealed.iv, 12, 12);
  const ciphertext = decodeBase64(sealed.ciphertext, 1, PLAINTEXT_LIMIT);
  const tag = decodeBase64(sealed.tag, 16, 16);
  const key = deriveKey(secret, ephemeral, ephemeralDer, recipientDer);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = parseObject(plaintext, ['token', 'expire_time']);
    validateToken(payload.token);
    validateExpiry(payload.expire_time);
    writeNewFiles([
      [options['token-out'], payload.token],
      [
        options['meta-out'],
        JSON.stringify({ expire_time: payload.expire_time }),
      ],
    ]);
  } finally {
    key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
  console.log('GCS_PROOF_HANDOFF_OPENED');
}

const commands = {
  keygen: { flags: ['dir'], run: keygen },
  seal: {
    flags: ['key-json', 'token-file', 'expire-time', 'context', 'out'],
    run: seal,
  },
  open: {
    flags: ['key-pem', 'sealed', 'context', 'token-out', 'meta-out'],
    run: open,
  },
};

try {
  const [command, ...args] = process.argv.slice(2);
  const spec = Object.hasOwn(commands, command) && commands[command];
  requireValue(
    spec && args.length === spec.flags.length * 2,
    'invalid arguments'
  );
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].startsWith('--') ? args[index].slice(2) : '';
    const value = args[index + 1];
    requireValue(
      spec.flags.includes(name) && !Object.hasOwn(options, name) && value,
      'invalid arguments'
    );
    options[name] = value;
  }
  spec.run(options);
} catch {
  // Input, filesystem, and crypto errors may carry secrets. Never print them.
  console.error('GCS_PROOF_ERROR handoff: operation failed');
  process.exitCode = 1;
}
