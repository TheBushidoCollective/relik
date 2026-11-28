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
        !/^\.(?:git|github|omp)(?:$|-)/i.test(part) &&
        !/^omp-(?:agent|runtime)$/i.test(part)
    ) &&
    !/^error-report/i.test(name) &&
    !/(?:\.db(?:-wal|-shm)?|\.sqlite(?:3)?(?:-wal|-shm)?)$/i.test(name) &&
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
      i++;
    }
    if (hunks === 0) throw new Error('Patch refused');
  }
  if (files.length === 0 || i < lines.length - 1)
    throw new Error('Patch refused');
  return { files, flagged: flags, tests };
}

function collect(value: unknown, values: Set<string>): void {
  if (typeof value === 'string') {
    if (!value) return;
    values.add(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'string' || parsed !== value)
        collect(parsed, values);
    } catch {
      /* A credential need not be JSON. */
    }
  } else if (typeof value === 'number' && Number.isFinite(value))
    values.add(String(value));
  else if (Array.isArray(value))
    for (const item of value) collect(item, values);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) collect(item, values);
}

/** DB contents stay in this process; callers must never log the examined values. */
export function hasCredential(
  patch: string,
  databaseValues: readonly unknown[]
): boolean {
  const values = new Set<string>();
  for (const value of databaseValues) collect(value, values);
  return (
    [...values].some((value) => patch.includes(value)) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(patch))
  );
}
