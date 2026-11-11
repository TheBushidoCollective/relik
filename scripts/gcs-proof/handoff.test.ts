import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDOFF = fileURLToPath(new URL('./handoff.js', import.meta.url));
const AWAIT = fileURLToPath(new URL('./await-artifact.sh', import.meta.url));
const RUN = '123456789';
const ATTEMPT = '2';
const TOKEN = 'proof-token-abcdefghijklmnopqrstuvwxyz-0123456789';
const EXPIRY = '2030-11-10T12:00:00.123456789Z';
const CONTEXT =
  `run=${RUN} attempt=${ATTEMPT} ` +
  `account=rgp-${RUN}-${ATTEMPT}@relic-test.iam.gserviceaccount.com ` +
  'expires=1920528000';
const KEY_ARTIFACT = `gcs-proof-handoff-key-${RUN}-${ATTEMPT}`;
const TOKEN_ARTIFACT = `gcs-proof-handoff-token-${RUN}-${ATTEMPT}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relic-gcs-handoff-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', [HANDOFF, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: RUN,
      GITHUB_RUN_ATTEMPT: ATTEMPT,
      ...env,
    },
  });
}

function rejected(result: SpawnSyncReturns<string>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN);
  expect(result.stdout).not.toContain('not-a-real-github-token');
  expect(result.stderr).not.toContain('not-a-real-github-token');
}

function keygen(path = dir) {
  const result = cli(['keygen', '--dir', path]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  return {
    pem: join(path, 'handoff-key.pem'),
    public: join(path, 'handoff-key.json'),
  };
}

function tokenFile(value = TOKEN, path = join(dir, 'minted-token')) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function sealArgs(
  key: string,
  token: string,
  out: string,
  context = CONTEXT,
  expiry = EXPIRY
) {
  return [
    'seal',
    '--key-json',
    key,
    '--token-file',
    token,
    '--expire-time',
    expiry,
    '--context',
    context,
    '--out',
    out,
  ];
}

function openArgs(
  key: string,
  sealed: string,
  out: string,
  meta: string,
  context = CONTEXT
) {
  return [
    'open',
    '--key-pem',
    key,
    '--sealed',
    sealed,
    '--context',
    context,
    '--token-out',
    out,
    '--meta-out',
    meta,
  ];
}

function prepared() {
  const keys = keygen();
  const token = tokenFile();
  const sealed = join(dir, 'sealed.json');
  const result = cli(sealArgs(keys.public, token, sealed));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  return {
    ...keys,
    token,
    sealed,
    out: join(dir, 'opened-token'),
    meta: join(dir, 'opened-meta.json'),
  };
}

function fixedPrivateKey(byte: number) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      Buffer.alloc(32, byte),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

function referenceKey(
  privatePart: KeyObject,
  publicPart: KeyObject,
  ephemeralDer: Buffer,
  recipientDer: Buffer
) {
  const shared = diffieHellman({
    privateKey: privatePart,
    publicKey: publicPart,
  });
  const salt = createHash('sha256')
    .update(ephemeralDer)
    .update(recipientDer)
    .digest();
  return Buffer.from(
    hkdfSync('sha256', shared, salt, 'relic-gcs-proof-handoff v1', 32)
  );
}

function referenceEnvelope(recipient: KeyObject, payload: unknown) {
  const ephemeral = fixedPrivateKey(2);
  const recipientPublic = createPublicKey(recipient);
  const recipientDer = recipientPublic.export({ format: 'der', type: 'spki' });
  const ephemeralDer = createPublicKey(ephemeral).export({
    format: 'der',
    type: 'spki',
  });
  const key = referenceKey(
    ephemeral,
    recipientPublic,
    ephemeralDer,
    recipientDer
  );
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`relic-gcs-proof-handoff v1\n${CONTEXT}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    ephemeral: ephemeralDer.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

describe('encrypted handoff', () => {
  test('round trips an exact token and expiration without exposing them', () => {
    const paths = prepared();
    const publicFile = readFileSync(paths.public, 'utf8');
    const sealedFile = readFileSync(paths.sealed, 'utf8');
    expect(Buffer.byteLength(publicFile)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(sealedFile)).toBeLessThanOrEqual(16384);
    expect(JSON.parse(publicFile).version).toBe(1);
    expect(JSON.parse(sealedFile).version).toBe(1);
    expect(sealedFile).not.toContain(TOKEN);
    expect(statSync(paths.pem).mode & 0o777).toBe(0o600);

    const result = cli(
      openArgs(paths.pem, paths.sealed, paths.out, paths.meta)
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('GCS_PROOF_HANDOFF_OPENED\n');
    expect(result.stderr).toBe('');
    expect(readFileSync(paths.out, 'utf8')).toBe(TOKEN);
    expect(JSON.parse(readFileSync(paths.meta, 'utf8'))).toEqual({
      expire_time: EXPIRY,
    });
    expect(statSync(paths.out).mode & 0o777).toBe(0o600);
    expect(statSync(paths.meta).mode & 0o777).toBe(0o600);
  });

  test('opens the independently constructed deterministic wire format', () => {
    const recipient = fixedPrivateKey(1);
    const envelope = referenceEnvelope(recipient, {
      token: TOKEN,
      expire_time: EXPIRY,
    });
    const pem = join(dir, 'fixed.pem');
    writeFileSync(pem, recipient.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    chmodSync(pem, 0o600);
    const sealed = join(dir, 'fixed-sealed.json');
    writeFileSync(sealed, envelope);
    const out = join(dir, 'fixed-token');
    const meta = join(dir, 'fixed-meta');
    expect(cli(openArgs(pem, sealed, out, meta)).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(TOKEN);
    expect(JSON.parse(readFileSync(meta, 'utf8'))).toEqual({
      expire_time: EXPIRY,
    });
  });

  test('rejects authenticated but invalid token or expiration payloads', () => {
    const recipient = fixedPrivateKey(1);
    const pem = join(dir, 'fixed.pem');
    writeFileSync(pem, recipient.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    chmodSync(pem, 0o600);
    const invalid = [
      { token: `${TOKEN}\n`, expire_time: EXPIRY },
      { token: 'too-short', expire_time: EXPIRY },
      { token: TOKEN, expire_time: '2030-02-30T12:00:00Z' },
      { token: TOKEN, expire_time: EXPIRY, extra: 'unexpected' },
    ];
    for (const [index, payload] of invalid.entries()) {
      const sealed = join(dir, `invalid-payload-${index}`);
      writeFileSync(sealed, referenceEnvelope(recipient, payload));
      const out = join(dir, `invalid-token-${index}`);
      const meta = join(dir, `invalid-meta-${index}`);
      rejected(cli(openArgs(pem, sealed, out, meta)));
      expect(existsSync(out)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    }
  });

  test('seals data readable by an independent implementation', () => {
    const paths = prepared();
    const recipient = createPrivateKey(readFileSync(paths.pem));
    const recipientDer = createPublicKey(recipient).export({
      format: 'der',
      type: 'spki',
    });
    const sealed = JSON.parse(readFileSync(paths.sealed, 'utf8'));
    const ephemeralDer = Buffer.from(sealed.ephemeral, 'base64');
    const ephemeral = createPublicKey({
      key: ephemeralDer,
      format: 'der',
      type: 'spki',
    });
    const key = referenceKey(recipient, ephemeral, ephemeralDer, recipientDer);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(sealed.iv, 'base64')
    );
    decipher.setAAD(Buffer.from(`relic-gcs-proof-handoff v1\n${CONTEXT}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]);
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual({
      token: TOKEN,
      expire_time: EXPIRY,
    });
  });

  test('authenticates the run context and rejects a different run environment', () => {
    const paths = prepared();
    const contexts = [
      CONTEXT.replace('expires=1920528000', 'expires=1920528001'),
      CONTEXT.replace('relic-test.iam', 'relic-other.iam'),
      `${CONTEXT}\n`,
    ];
    for (const context of contexts) {
      rejected(
        cli(openArgs(paths.pem, paths.sealed, paths.out, paths.meta, context))
      );
      expect(existsSync(paths.out)).toBe(false);
      expect(existsSync(paths.meta)).toBe(false);
    }
    rejected(
      cli(openArgs(paths.pem, paths.sealed, paths.out, paths.meta), {
        GITHUB_RUN_ATTEMPT: '3',
      })
    );
    const invalidContexts = [
      `${CONTEXT}\n`,
      CONTEXT.replace(`rgp-${RUN}-${ATTEMPT}@`, `rgp-999-${ATTEMPT}@`),
    ];
    for (const context of invalidContexts) {
      rejected(
        cli(
          sealArgs(
            paths.public,
            paths.token,
            join(dir, 'invalid-context'),
            context
          )
        )
      );
      expect(existsSync(join(dir, 'invalid-context'))).toBe(false);
    }
  });

  test('rejects changes to every authenticated envelope component', () => {
    const paths = prepared();
    const original = JSON.parse(readFileSync(paths.sealed, 'utf8'));
    for (const field of ['ciphertext', 'tag', 'iv', 'ephemeral']) {
      const bytes = Buffer.from(original[field], 'base64');
      bytes[bytes.length - 1] ^= 1;
      const tampered = join(dir, `tampered-${field}.json`);
      writeFileSync(
        tampered,
        JSON.stringify({ ...original, [field]: bytes.toString('base64') })
      );
      rejected(cli(openArgs(paths.pem, tampered, paths.out, paths.meta)));
      expect(existsSync(paths.out)).toBe(false);
      expect(existsSync(paths.meta)).toBe(false);
    }
  });

  test('rejects another X25519 private key', () => {
    const paths = prepared();
    const other = join(dir, 'other');
    mkdirSync(other);
    const keys = keygen(other);
    rejected(cli(openArgs(keys.pem, paths.sealed, paths.out, paths.meta)));
    expect(existsSync(paths.out)).toBe(false);
  });

  test('rejects a non-X25519 public key', () => {
    const token = tokenFile();
    const { publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const key = join(dir, 'wrong-public.json');
    writeFileSync(
      key,
      JSON.stringify({ version: 1, x25519: der.toString('base64') })
    );
    const out = join(dir, 'sealed.json');
    rejected(cli(sealArgs(key, token, out)));
    expect(existsSync(out)).toBe(false);
  });

  test('uses a new ephemeral key and IV for each seal', () => {
    const paths = prepared();
    const second = join(dir, 'second-sealed.json');
    expect(cli(sealArgs(paths.public, paths.token, second)).status).toBe(0);
    const firstValue = JSON.parse(readFileSync(paths.sealed, 'utf8'));
    const secondValue = JSON.parse(readFileSync(second, 'utf8'));
    expect(secondValue.ephemeral).not.toBe(firstValue.ephemeral);
    expect(secondValue.iv).not.toBe(firstValue.iv);
  });

  test('accepts both token length boundaries', () => {
    const keys = keygen();
    const cases = [
      'a'.repeat(20),
      'a'.repeat(4096),
      '"'.repeat(4096),
      '\\'.repeat(4096),
    ];
    for (const [index, token] of cases.entries()) {
      const input = tokenFile(token, join(dir, `token-${index}`));
      const sealed = join(dir, `sealed-${index}`);
      const out = join(dir, `out-${index}`);
      const meta = join(dir, `meta-${index}`);
      expect(cli(sealArgs(keys.public, input, sealed)).status).toBe(0);
      expect(cli(openArgs(keys.pem, sealed, out, meta)).status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(token);
    }
  });

  test('rejects invalid tokens, expiry, and insecure token modes', () => {
    const keys = keygen();
    const invalid = [
      '',
      'a'.repeat(19),
      `${TOKEN}\n`,
      `${TOKEN} `,
      `${TOKEN}é`,
      'a'.repeat(4097),
    ];
    for (const [index, value] of invalid.entries()) {
      const path = tokenFile(value, join(dir, `bad-token-${index}`));
      const out = join(dir, `bad-sealed-${index}`);
      rejected(cli(sealArgs(keys.public, path, out)));
      expect(existsSync(out)).toBe(false);
    }
    const token = tokenFile();
    for (const expiry of [
      '2030-02-30T12:00:00Z',
      'not-a-date',
      '2030-11-10T12:00:00+00:00',
    ]) {
      rejected(
        cli(
          sealArgs(keys.public, token, join(dir, 'bad-date'), CONTEXT, expiry)
        )
      );
    }
    chmodSync(token, 0o644);
    rejected(cli(sealArgs(keys.public, token, join(dir, 'bad-mode'))));
  });

  test('rejects oversized input files and symlinks', () => {
    const paths = prepared();
    const oversizedKey = join(dir, 'oversized-public.json');
    const oversizedSealed = join(dir, 'oversized-sealed.json');
    const oversizedPem = join(dir, 'oversized.pem');
    writeFileSync(oversizedKey, 'x'.repeat(1025));
    writeFileSync(oversizedSealed, 'x'.repeat(16385));
    writeFileSync(oversizedPem, 'x'.repeat(2049), { mode: 0o600 });
    chmodSync(oversizedPem, 0o600);
    rejected(
      cli(sealArgs(oversizedKey, paths.token, join(dir, 'bad-key-out')))
    );
    rejected(cli(openArgs(paths.pem, oversizedSealed, paths.out, paths.meta)));
    rejected(cli(openArgs(oversizedPem, paths.sealed, paths.out, paths.meta)));
    const link = join(dir, 'key-link');
    symlinkSync(paths.public, link);
    rejected(cli(sealArgs(link, paths.token, join(dir, 'link-out'))));
    expect(existsSync(paths.out)).toBe(false);
  });

  test('rejects duplicate JSON fields and noncanonical base64', () => {
    const paths = prepared();
    const key = JSON.parse(readFileSync(paths.public, 'utf8'));
    const duplicate = join(dir, 'duplicate.json');
    writeFileSync(
      duplicate,
      `{"version":2,"version":1,"x25519":"${key.x25519}"}`
    );
    rejected(cli(sealArgs(duplicate, paths.token, join(dir, 'duplicate-out'))));
    const malformed = join(dir, 'malformed.json');
    writeFileSync(
      malformed,
      JSON.stringify({ ...key, x25519: `${key.x25519}!` })
    );
    rejected(cli(sealArgs(malformed, paths.token, join(dir, 'malformed-out'))));
    const sealed = JSON.parse(readFileSync(paths.sealed, 'utf8'));
    writeFileSync(
      malformed,
      JSON.stringify({ ...sealed, iv: `${sealed.iv}!` })
    );
    rejected(cli(openArgs(paths.pem, malformed, paths.out, paths.meta)));
  });

  test('never overwrites keys or partially overwrites output pairs', () => {
    const paths = prepared();
    const pem = readFileSync(paths.pem, 'utf8');
    const publicData = readFileSync(paths.public, 'utf8');
    rejected(cli(['keygen', '--dir', dir]));
    expect(readFileSync(paths.pem, 'utf8')).toBe(pem);
    expect(readFileSync(paths.public, 'utf8')).toBe(publicData);
    rmSync(paths.pem);
    rejected(cli(['keygen', '--dir', dir]));
    expect(existsSync(paths.pem)).toBe(false);
    expect(readFileSync(paths.public, 'utf8')).toBe(publicData);
    writeFileSync(paths.pem, pem, { mode: 0o600 });

    const oldSealed = readFileSync(paths.sealed, 'utf8');
    rejected(cli(sealArgs(paths.public, paths.token, paths.sealed)));
    expect(readFileSync(paths.sealed, 'utf8')).toBe(oldSealed);
    writeFileSync(paths.meta, 'sentinel', { mode: 0o600 });
    rejected(cli(openArgs(paths.pem, paths.sealed, paths.out, paths.meta)));
    expect(existsSync(paths.out)).toBe(false);
    expect(readFileSync(paths.meta, 'utf8')).toBe('sentinel');
  });

  test('rejects duplicate flags without printing their values', () => {
    const result = cli(['keygen', '--dir', dir, '--dir', TOKEN]);
    rejected(result);
    expect(existsSync(join(dir, 'handoff-key.pem'))).toBe(false);
  });
});

const MOCK_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == api ]]; then
  printf '%s' "$MOCK_PAGES"
  exit "\${MOCK_API_STATUS:-0}"
fi
[[ "$1" == run && "$2" == download ]] || exit 1
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) target=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "\${MOCK_MODE:-normal}" in
  symlink) ln -s "$MOCK_PAYLOAD" "$target/$MOCK_FILE" ;;
  extra) cp "$MOCK_PAYLOAD" "$target/$MOCK_FILE"; touch "$target/extra" ;;
  nested) mkdir "$target/nested"; cp "$MOCK_PAYLOAD" "$target/nested/$MOCK_FILE" ;;
  *) cp "$MOCK_PAYLOAD" "$target/$MOCK_FILE" ;;
esac
`;

function awaitArtifact(
  options: {
    name?: string;
    file?: string;
    destination?: string;
    max?: string;
    deadline?: string;
    pages?: unknown;
    mode?: string;
    payload?: string;
    run?: string;
    attempt?: string;
    repository?: string;
  } = {}
) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, MOCK_GH, { mode: 0o700 });
  chmodSync(gh, 0o700);
  const payload = join(dir, 'artifact-payload');
  writeFileSync(payload, options.payload ?? '{"version":1}');
  const name = options.name ?? KEY_ARTIFACT;
  const file = options.file ?? 'handoff-key.json';
  const destination = options.destination ?? join(dir, 'downloaded');
  const log = join(dir, 'gh-invocations');
  const pages = options.pages ?? [
    { artifacts: [{ id: 1, name, expired: false }] },
  ];
  const result = spawnSync(
    'bash',
    [
      AWAIT,
      name,
      file,
      destination,
      options.deadline ?? '10',
      options.max ?? '1024',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_RUN_ID: options.run ?? RUN,
        GITHUB_RUN_ATTEMPT: options.attempt ?? ATTEMPT,
        GITHUB_REPOSITORY: options.repository ?? 'owner/repo',
        GH_TOKEN: 'not-a-real-github-token',
        MOCK_LOG: log,
        MOCK_PAGES: JSON.stringify(pages),
        MOCK_MODE: options.mode ?? 'normal',
        MOCK_PAYLOAD: payload,
        MOCK_FILE: file,
      },
    }
  );
  return { result, destination, log };
}

describe('run-scoped artifact download', () => {
  test('downloads exactly one unexpired artifact from the current run', () => {
    const { result, destination, log } = awaitArtifact();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(readFileSync(destination, 'utf8')).toBe('{"version":1}');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(
      `repos/owner/repo/actions/runs/${RUN}/artifacts?name=${KEY_ARTIFACT}`
    );
    expect(calls).toContain(
      `run download ${RUN} --repo owner/repo --name ${KEY_ARTIFACT}`
    );
    expect(
      readdirSync(dir).some((name) => name.startsWith('.gcs-proof-handoff.'))
    ).toBe(false);
  });

  test('supports the token artifact with its own filename and byte limit', () => {
    const { result, destination } = awaitArtifact({
      name: TOKEN_ARTIFACT,
      file: 'sealed.json',
      max: '16384',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('{"version":1}');
  });

  test('excludes expired matches without discarding the single live artifact', () => {
    const { result, destination } = awaitArtifact({
      pages: [
        {
          artifacts: [
            { id: 1, name: KEY_ARTIFACT, expired: true },
            { id: 2, name: KEY_ARTIFACT, expired: false },
          ],
        },
      ],
    });
    expect(result.status).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('{"version":1}');
  });

  test('rejects duplicate names across API pages', () => {
    const artifact = { id: 1, name: KEY_ARTIFACT, expired: false };
    const { result, destination } = awaitArtifact({
      pages: [
        { artifacts: [artifact] },
        { artifacts: [{ ...artifact, id: 2 }] },
      ],
    });
    rejected(result);
    expect(existsSync(destination)).toBe(false);
  });

  test('ignores expired or differently named artifacts and honors the deadline', () => {
    const { result, destination } = awaitArtifact({
      deadline: '1',
      pages: [
        {
          artifacts: [
            { id: 1, name: KEY_ARTIFACT, expired: true },
            { id: 2, name: `${KEY_ARTIFACT}-other`, expired: false },
          ],
        },
      ],
    });
    rejected(result);
    expect(existsSync(destination)).toBe(false);
  });

  test('rejects wrong run, attempt, repository, filename, and relaxed limits', () => {
    const cases = [
      { name: `gcs-proof-handoff-key-999-${ATTEMPT}` },
      { attempt: '3' },
      { repository: '../repo' },
      { file: '../handoff-key.json' },
      { max: '1025' },
      { deadline: '0' },
    ];
    for (const options of cases) {
      const { result, destination } = awaitArtifact(options);
      rejected(result);
      expect(existsSync(destination)).toBe(false);
    }
  });

  test('rejects malformed API data, extra files, nested files, and symlinks', () => {
    for (const options of [
      { pages: [{ wrong: [] }] },
      { mode: 'extra' },
      { mode: 'nested' },
      { mode: 'symlink' },
    ]) {
      const { result, destination } = awaitArtifact(options);
      rejected(result);
      expect(existsSync(destination)).toBe(false);
    }
  });

  test('rejects oversized artifacts and never overwrites destinations', () => {
    const oversized = awaitArtifact({ payload: 'x'.repeat(1025) });
    rejected(oversized.result);
    expect(existsSync(oversized.destination)).toBe(false);
    const destination = join(dir, 'existing');
    writeFileSync(destination, 'sentinel');
    const existing = awaitArtifact({ destination });
    rejected(existing.result);
    expect(readFileSync(destination, 'utf8')).toBe('sentinel');
  });
});
