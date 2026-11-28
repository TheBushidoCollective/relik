const MAX_PATCH_BYTES = 200_000;
const MAX_FILES = 20;
const PATH =
  /^packages\/relic-(?:format|server|viewer|mcp)\/(?:src|test)\/[A-Za-z0-9._/-]{1,140}$/;
const SENSITIVE =
  /^(?:rfc8188|hpke|envelope|fragment|sha256|private|private-wire|passkey.*|webauthn.*|signing|share|stream|stream-any|mnemonic|id|sandbox.*|rtc-guard|frame-scripts|csp.*|device|secure-enclave|state|origin|install|installer|config|ratelimit|problems|gcs|gcsstore|store|mail)$/i;
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,255}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

// This digest is already public in .github/omp-context.pin.
const ALLOWED_LONG_HASHES: Record<string, true> = {
  '9fa8832a5b1c8eb134d68b397bc07262c9719f20467eafb8c3dcffd57d1b4e92': true,
};
const SECRET_WINDOW = 16;
const MAX_CREDENTIAL_VALUE = 16_384;

export interface PatchSummary {
  files: string[];
  flagged: string[];
  tests: string[];
}

function safePath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return (
    PATH.test(path) &&
    !path.includes('..') &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        !/^\.(?:git|editorconfig|omp)/i.test(part) &&
        !/^omp-(?:agent|runtime)(?:$|-)/i.test(part)
    ) &&
    !/^error-report/i.test(name) &&
    !/\.(?:patch|diff)$/i.test(name) &&
    !/(?:\.db(?:-wal|-shm|-journal)?|\.sqlite(?:3)?(?:-wal|-shm|-journal)?)$/i.test(
      name
    ) &&
    !/^(?:package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(
      name
    )
  );
}
function flagged(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return (
    path.includes('/private/') ||
    path === 'packages/relic-server/src/app.ts' ||
    SENSITIVE.test(name.replace(/\.[^.]+$/, ''))
  );
}

function containsControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      return true;
  }
  return false;
}

function safeAddedLine(line: string): boolean {
  if (line.length > 200) return false;
  for (const char of line) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) return false;
  }
  for (const match of line.matchAll(/[A-Za-z0-9+/_=-]{20,}/g)) {
    const token = match[0];
    if (Object.hasOwn(ALLOWED_LONG_HASHES, token)) continue;
    if (token.length >= 32) return false;
    const counts = new Map<string, number>();
    for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
      const probability = count / token.length;
      entropy -= probability * Math.log2(probability);
    }
    if (entropy >= 3.8) return false;
  }
  return true;
}

/** Validate a normal textual git patch as data. git apply --check remains mandatory. */
export function checkPatch(patch: string): PatchSummary {
  if (
    typeof patch !== 'string' ||
    new TextEncoder().encode(patch).length > MAX_PATCH_BYTES ||
    containsControl(patch)
  )
    throw new Error('Patch refused');
  const lines = patch.split('\n');
  const files: string[] = [];
  const flags: string[] = [];
  const tests: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i] !== '') {
    const header = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(lines[i] ?? '');
    if (
      !header ||
      header[1] !== header[2] ||
      !safePath(header[1] ?? '') ||
      files.includes(header[1] ?? '')
    )
      throw new Error('Patch refused');
    const path = header[1]!;
    files.push(path);
    if (files.length > MAX_FILES) throw new Error('Patch refused');
    if (flagged(path)) flags.push(path);
    if (/\/test\/.*\.test\.ts$/.test(path)) tests.push(path);
    i++;
    let added = false;
    let deleted = false;
    let indexed = false;
    let indexedRegular = false;
    while (i < lines.length && !(lines[i] ?? '').startsWith('--- ')) {
      const line = lines[i] ?? '';
      if (line === 'new file mode 100644' && !added && !deleted) added = true;
      else if (line === 'deleted file mode 100644' && !added && !deleted)
        deleted = true;
      else if (
        /^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: 100644)?$/.test(line) &&
        !indexed
      ) {
        indexed = true;
        indexedRegular = line.endsWith(' 100644');
      } else throw new Error('Patch refused');
      i++;
    }
    if (
      !indexed ||
      (!added && !deleted && !indexedRegular) ||
      (deleted && path.includes('/test/')) ||
      lines[i] !== (added ? '--- /dev/null' : `--- a/${path}`) ||
      lines[i + 1] !== (deleted ? '+++ /dev/null' : `+++ b/${path}`)
    )
      throw new Error('Patch refused');
    i += 2;
    let hunks = 0;
    while (i < lines.length && !(lines[i] ?? '').startsWith('diff --git ')) {
      const line = lines[i] ?? '';
      if (line === '' && i === lines.length - 1) {
        i++;
        break;
      }
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(line)) hunks++;
      else if (
        hunks === 0 ||
        !/^(?:[ +-]|\\ No newline at end of file)/.test(line)
      )
        throw new Error('Patch refused');
      if (line.startsWith('+') && !safeAddedLine(line.slice(1)))
        throw new Error('Patch refused');
      i++;
    }
    if (hunks === 0) throw new Error('Patch refused');
  }
  if (files.length === 0 || i < lines.length - 1)
    throw new Error('Patch refused');
  return { files, flagged: flags, tests };
}

function collect(
  value: unknown,
  values: Set<string>,
  binary: Uint8Array[]
): void {
  if (typeof value === 'string') {
    if (!value) return;
    values.add(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'string' || parsed !== value)
        collect(parsed, values, binary);
    } catch {
      // Credentials need not be JSON.
    }
  } else if (value instanceof Uint8Array) {
    if (value.length <= MAX_CREDENTIAL_VALUE) binary.push(value);
    let sequence = '';
    for (const char of new TextDecoder('utf-8').decode(value)) {
      const code = char.codePointAt(0)!;
      if (code >= 32 && code !== 127 && code !== 0xfffd) sequence += char;
      else {
        if (sequence.length >= SECRET_WINDOW) values.add(sequence);
        sequence = '';
      }
    }
    if (sequence.length >= SECRET_WINDOW) values.add(sequence);
  } else if (Array.isArray(value))
    for (const item of value) collect(item, values, binary);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) collect(item, values, binary);
}

function normalize(value: string): string {
  return value.replace(/[\s'"`+,.():;[\]{}\-_=\\/%]/g, '');
}

/** DB contents stay in this process; callers must never log the examined values. */
export function hasCredential(
  patch: string,
  databaseValues: readonly unknown[]
): boolean {
  const values = new Set<string>();
  const binary: Uint8Array[] = [];
  for (const value of databaseValues) collect(value, values, binary);
  const normalized = normalize(patch);
  const windows = new Set<string>();
  for (let i = 0; i <= normalized.length - SECRET_WINDOW; i++)
    windows.add(normalized.slice(i, i + SECRET_WINDOW));
  const lowerWindows = new Set(
    [...windows].map((value) => value.toLowerCase())
  );
  const contains = (candidate: string): boolean => {
    if (!candidate) return false;
    if (patch.includes(candidate)) return true;
    const compact = normalize(candidate);
    for (let i = 0; i <= compact.length - SECRET_WINDOW; i++)
      if (windows.has(compact.slice(i, i + SECRET_WINDOW))) return true;
    return false;
  };
  const containsHex = (candidate: string): boolean => {
    const compact = normalize(candidate).toLowerCase();
    for (let i = 0; i <= compact.length - SECRET_WINDOW; i++)
      if (lowerWindows.has(compact.slice(i, i + SECRET_WINDOW))) return true;
    return false;
  };
  const scanBytes = (bytes: Uint8Array): boolean => {
    if (bytes.length === 0) return false;
    if (bytes.length > MAX_CREDENTIAL_VALUE) return true;
    const buffer = Buffer.from(bytes);
    const hex = buffer.toString('hex');
    if (
      contains(hex) ||
      contains(hex.toUpperCase()) ||
      containsHex(hex) ||
      containsHex([...hex].reverse().join(''))
    )
      return true;
    for (let padding = 0; padding < 3; padding++) {
      const padded = Buffer.concat([Buffer.alloc(padding), buffer]);
      const encoded = padded
        .toString('base64')
        .slice(Math.ceil((padding * 8) / 6));
      for (const variant of [
        encoded,
        encoded.replaceAll('+', '-').replaceAll('/', '_'),
      ]) {
        const reversed = [...variant].reverse().join('');
        const rotated = variant.replace(/[A-Za-z]/g, (char) =>
          String.fromCharCode(
            char.charCodeAt(0) + (char.toLowerCase() <= 'm' ? 13 : -13)
          )
        );
        if (contains(variant) || contains(reversed) || contains(rotated))
          return true;
      }
    }
    return false;
  };
  for (const value of values) {
    if (value.length > MAX_CREDENTIAL_VALUE) return true;
    if (contains(value)) return true;
    const reversed = [...value].reverse().join('');
    const rot13 = value.replace(/[A-Za-z]/g, (char) =>
      String.fromCharCode(
        char.charCodeAt(0) + (char.toLowerCase() <= 'm' ? 13 : -13)
      )
    );
    const rot47 = value.replace(/[!-~]/g, (char) =>
      String.fromCharCode(33 + ((char.charCodeAt(0) - 33 + 47) % 94))
    );
    for (const variant of [value, reversed, rot13, rot47])
      if (contains(variant) || scanBytes(Buffer.from(variant))) return true;
  }
  return (
    binary.some(scanBytes) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(patch))
  );
}
